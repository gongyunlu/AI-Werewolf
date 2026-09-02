import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { ACTION_TYPES, FACTIONS } from '@ai-werewolf/shared';
import { JudgeOutputSchema, SpeechJudgeOutputSchema, validateSpeechOutput } from './judge-schema';
import {
  buildJudgePromptVariables,
  buildSpeechJudgePromptVariables,
  type JudgeEventInput,
} from './judge-prompt';
import { isJudgeableAction } from './action-catalog';

/**
 * LLM-as-judge 决策质量评估服务。
 *
 * 对单个决策事件做「决策时点视角还原」，调用 judge 模型打分并落 DecisionJudgment。
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: PromptService,
    private readonly structuredLlm: StructuredLlmService,
  ) {}

  /** 找出对局内所有可评估的决策事件 id */
  async findJudgeableEvents(gameId: string): Promise<string[]> {
    const events = await this.prisma.event.findMany({
      // 无 actor 的系统事件无法归属到玩家，也不会被 judgeEvent 落 Judgment；
      // 在任务发现阶段就排除，确保完成度分母与真正可落库的目标一致。
      where: { gameId, actorId: { not: null } },
      select: { id: true, actionType: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    return events
      .filter((e) => isJudgeableAction(e.actionType, (e.content as Record<string, unknown>) ?? {}))
      .map((e) => e.id);
  }

  /** 评估单个决策事件并落库 */
  async judgeEvent(gameId: string, eventId: string): Promise<void> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        gameId: true,
        sequence: true,
        day: true,
        actionType: true,
        visibility: true,
        actorId: true,
        content: true,
      },
    });

    if (!event || event.gameId !== gameId) {
      this.logger.warn({ gameId, eventId }, '决策事件不存在或不属于该对局，跳过评估');
      return;
    }

    const content = (event.content as Record<string, unknown>) ?? {};
    if (!isJudgeableAction(event.actionType, content)) {
      return;
    }
    if (!event.actorId) {
      this.logger.warn({ gameId, eventId }, '决策事件缺少 actorId，跳过评估');
      return;
    }

    const player = await this.prisma.player.findUnique({
      where: { id: event.actorId },
      select: { id: true, seatNo: true, role: true, faction: true, deathDay: true },
    });
    if (!player) {
      this.logger.warn({ gameId, eventId, actorId: event.actorId }, '决策玩家不存在，跳过评估');
      return;
    }

    const teammates = await this.loadTeammates(gameId, player.id, player.faction);

    // 只取决策时点之前的事件：buildJudgePromptVariables 内部本就按 sequence < decision.sequence 过滤，
    // 决策之后的事件对评估无意义，SQL 层下推减少返回行数
    const allEvents = await this.prisma.event.findMany({
      where: { gameId, sequence: { lt: event.sequence } },
      select: {
        sequence: true,
        day: true,
        actionType: true,
        visibility: true,
        actorId: true,
        content: true,
      },
      orderBy: { sequence: 'asc' },
    });

    const judgeEvents: JudgeEventInput[] = allEvents.map((e) => ({
      sequence: e.sequence,
      day: e.day,
      actionType: e.actionType,
      visibility: e.visibility,
      actorId: e.actorId,
      content: (e.content as Record<string, unknown>) ?? {},
    }));

    const variables = buildJudgePromptVariables({
      playerId: player.id,
      playerSeatNo: player.seatNo,
      playerRole: player.role ?? '',
      playerFaction: player.faction ?? '',
      isAlive: player.deathDay === null || (event.day ?? 0) <= player.deathDay,
      teammates,
      decision: {
        sequence: event.sequence,
        actionType: event.actionType,
        day: event.day ?? 0,
        targetSeatNo: typeof content.targetSeatNo === 'number' ? content.targetSeatNo : null,
        content,
        thinking: typeof content.thinking === 'string' ? content.thinking : undefined,
      },
      events: judgeEvents,
    });

    const [systemPrompt, userPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.judgeSystem),
      this.promptService.render(PROMPT_NAMES.judgeUser, variables),
    ]);

    const {
      output: { verdict, score, reasoning },
      modelName,
    } = await this.structuredLlm.invoke({
      schema: JudgeOutputSchema,
      runName: 'judge',
      scenario: 'judge',
      system: systemPrompt.text,
      user: userPrompt.text,
      gameId,
      playerId: player.id,
      seatNo: player.seatNo,
      role: player.role,
      promptName: userPrompt.name,
      promptVersion: userPrompt.version,
    });

    await this.prisma.decisionJudgment.upsert({
      where: { eventId },
      update: { verdict, score, reasoning, modelName },
      create: {
        gameId,
        playerId: player.id,
        eventId,
        actionType: event.actionType,
        day: event.day ?? 0,
        targetSeatNo: typeof content.targetSeatNo === 'number' ? content.targetSeatNo : null,
        verdict,
        score,
        reasoning,
        modelName,
      },
    });

    this.logger.log(
      { gameId, eventId, actionType: event.actionType, verdict, score },
      '决策评估完成',
    );
  }

  /** 找出对局内有过发言的玩家 id（发言按玩家整局批量评，不逐条送评） */
  async findSpeakingPlayers(gameId: string): Promise<string[]> {
    const rows = await this.prisma.event.findMany({
      where: { gameId, actionType: ACTION_TYPES.SPEECH, actorId: { not: null } },
      select: { actorId: true },
      distinct: ['actorId'],
      orderBy: { actorId: 'asc' },
    });
    return rows.map((r) => r.actorId).filter((id): id is string => id !== null);
  }

  /** 找出本局全部非空发言事件 id（与 prompt 里 targets 的过滤一致：speech 非空才算可评） */
  async findSpeechesToJudge(gameId: string): Promise<string[]> {
    const events = await this.prisma.event.findMany({
      // 与 findSpeakingPlayers 的 actor 条件保持一致，避免孤儿发言只进入状态分母却没有 job。
      where: { gameId, actionType: ACTION_TYPES.SPEECH, actorId: { not: null } },
      select: { id: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    return events
      .filter((e) => {
        const c = (e.content as Record<string, unknown>) ?? {};
        return typeof c.speech === 'string' && c.speech.trim().length > 0;
      })
      .map((e) => e.id);
  }

  /**
   * 统计本局真正可评的目标数：可评决策事件 + 非空发言事件。
   *
   * getStatus 用它当分母对齐 decisionJudgment.count（按事件数）。不能用 listGameJobs 的
   * job 数——发言按玩家批量评，一个 job 对应多条发言，量纲会对不上。
   */
  async countJudgeableTargets(gameId: string): Promise<number> {
    const [decisionIds, speechIds] = await Promise.all([
      this.findJudgeableEvents(gameId),
      this.findSpeechesToJudge(gameId),
    ]);
    return decisionIds.length + speechIds.length;
  }

  /**
   * 批量评估某玩家本局的全部发言。
   *
   * 一次调用评完整局：既省调用数，也让模型能发现「后一天推翻前一天说法」这类跨发言问题。
   * 代价是模型看得到该发言之后的信息，靠 prompt 硬约束「只能用发言之前的信息」来压制后见之明。
   */
  async judgeSpeeches(gameId: string, playerId: string): Promise<number> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, gameId: true, seatNo: true, role: true, faction: true, deathDay: true },
    });
    if (!player || player.gameId !== gameId) {
      this.logger.warn({ gameId, playerId }, '玩家不存在或不属于该对局，跳过发言评估');
      return 0;
    }

    const events = await this.prisma.event.findMany({
      where: { gameId },
      select: {
        sequence: true,
        day: true,
        actionType: true,
        visibility: true,
        actorId: true,
        content: true,
      },
      orderBy: { sequence: 'asc' },
    });

    const teammates = await this.loadTeammates(gameId, player.id, player.faction);
    const { variables, targets } = buildSpeechJudgePromptVariables({
      playerId: player.id,
      playerSeatNo: player.seatNo,
      playerRole: player.role ?? '',
      playerFaction: player.faction ?? '',
      deathDay: player.deathDay,
      teammates,
      events: events.map((e) => ({
        sequence: e.sequence,
        day: e.day,
        actionType: e.actionType,
        visibility: e.visibility,
        actorId: e.actorId,
        content: (e.content as Record<string, unknown>) ?? {},
      })),
    });

    if (targets.length === 0) {
      return 0;
    }

    const [systemPrompt, userPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.judgeSpeechSystem),
      this.promptService.render(PROMPT_NAMES.judgeSpeechUser, variables),
    ]);

    const { output, modelName } = await this.structuredLlm.invoke({
      schema: SpeechJudgeOutputSchema,
      runName: 'judge-speeches',
      scenario: 'judge',
      system: systemPrompt.text,
      user: userPrompt.text,
      gameId,
      playerId: player.id,
      seatNo: player.seatNo,
      role: player.role,
      promptName: userPrompt.name,
      promptVersion: userPrompt.version,
    });

    // 弱模型频繁漏标 index：条数对齐且全部漏标时按输出顺序回填（全漏标说明模型只是
    // 没写该字段而非乱序，顺序即时间线顺序，无错位风险）。部分漏标仍交 validateSpeechOutput
    // 抛错重试，不静默错位。
    if (
      output.items.length === targets.length &&
      output.items.every((item) => item.index == null)
    ) {
      output.items = output.items.map((item, i) => ({ ...item, index: i + 1 }));
    }

    // 校验 index 映射能否安全落到事件：数量对不上或 index 越界/重复/半标时抛错，
    // 让 job 失败重试，而不是把评分错位写进错误的事件
    validateSpeechOutput(output.items, targets.length);

    // 模型返回的 index 映射回事件；sequence 唯一，用它反查 eventId
    const sequences = targets.map((t) => t.sequence);
    const eventRows = await this.prisma.event.findMany({
      where: { gameId, sequence: { in: sequences } },
      select: { id: true, sequence: true },
    });
    const eventIdBySequence = new Map(eventRows.map((e) => [e.sequence, e.id]));

    let saved = 0;
    for (const item of output.items) {
      // index 已由 schema 保证必填、validateSpeechOutput 保证落在 1..targetCount 且唯一，
      // 因此只按 index 精确匹配；查不到事件说明数据不一致，丢弃该条而非猜一个目标
      const target = targets.find((t) => t.index === item.index);
      const eventId = target ? eventIdBySequence.get(target.sequence) : undefined;
      if (!target || !eventId) {
        this.logger.warn({ gameId, playerId, index: item.index }, '发言评分序号无法匹配，已丢弃');
        continue;
      }

      await this.prisma.decisionJudgment.upsert({
        where: { eventId },
        update: { verdict: item.verdict, score: item.score, reasoning: item.reasoning, modelName },
        create: {
          gameId,
          playerId: player.id,
          eventId,
          actionType: ACTION_TYPES.SPEECH,
          day: target.day ?? 0,
          targetSeatNo: null,
          verdict: item.verdict,
          score: item.score,
          reasoning: item.reasoning,
          modelName,
        },
      });
      saved += 1;
    }

    // 校验已保证 index 一一对应，落库数仍对不上说明事件数据不一致。
    // 此时抛错让 job 重试，不能返回成功：否则 completion 会放行，
    // reward 按不完整的评分回填，而「这局评过了」的假象会一直留在计数里。
    if (saved !== targets.length) {
      throw new Error(
        `发言评分落库数不符：期望 ${targets.length} 条，实际 ${saved} 条（gameId=${gameId} playerId=${playerId}）`,
      );
    }
    this.logger.log({ gameId, playerId, saved }, '发言评估完成');
    return saved;
  }

  /** 同阵营队友座位号：仅狼人阵营互通身份 */
  private async loadTeammates(
    gameId: string,
    playerId: string,
    faction: string | null,
  ): Promise<number[]> {
    if (faction !== FACTIONS.WEREWOLF) return [];
    const wolves = await this.prisma.player.findMany({
      where: { gameId, faction: FACTIONS.WEREWOLF, id: { not: playerId } },
      select: { seatNo: true },
    });
    return wolves.map((w) => w.seatNo).filter((s): s is number => s !== null);
  }

  /**
   * 回填本局 memory_usages 的 rewardScore：把注入过的经验关联到它服务的那次行为的评分。
   *
   * 新数据在行为 Event 写入后记录 eventId，可精确关联同日多次发言；旧数据 eventId 为 NULL，
   * 仅在 (playerId, actionType, day) 恰好一条真实 Event 且该 Event 有评分时保守兼容。
   * 「唯一评分」本身不够：同日弃权 + PK 有效票可能只有一条评分但有两次行为。每次读取全部 usage，
   * 因此 force 重评后会刷新旧 reward；不再可唯一匹配的旧样本会清空，避免保留陈旧分数。
   */
  async backfillRewards(gameId: string): Promise<number> {
    const [judgments, usages] = await Promise.all([
      this.prisma.decisionJudgment.findMany({
        where: { gameId },
        select: { eventId: true, playerId: true, actionType: true, day: true, score: true },
      }),
      this.prisma.memoryUsage.findMany({
        where: { gameId },
        select: {
          id: true,
          eventId: true,
          playerId: true,
          actionType: true,
          day: true,
          rewardScore: true,
        },
      }),
    ]);

    const scoreByEventId = new Map(judgments.map((j) => [j.eventId, j.score]));
    // 仅供迁移前的旧 usage 使用。必须检查底层真实 Event 是否也唯一，不能只数评分。
    const legacyScoreByKey = new Map<string, number>();
    if (usages.some((usage) => usage.eventId === null)) {
      const events = await this.prisma.event.findMany({
        where: { gameId, actorId: { not: null }, day: { not: null } },
        select: { id: true, actorId: true, actionType: true, day: true },
      });
      const eventIdsByKey = new Map<string, string[]>();
      for (const event of events) {
        if (!event.actorId || event.day === null) continue;
        const key = `${event.actorId}|${event.actionType}|${event.day}`;
        const list = eventIdsByKey.get(key);
        if (list) list.push(event.id);
        else eventIdsByKey.set(key, [event.id]);
      }
      for (const [key, eventIds] of eventIdsByKey) {
        if (eventIds.length !== 1) continue;
        const score = scoreByEventId.get(eventIds[0]);
        if (score !== undefined) legacyScoreByKey.set(key, score);
      }
    }

    let filled = 0;
    for (const u of usages) {
      const nextScore = u.eventId
        ? (scoreByEventId.get(u.eventId) ?? null)
        : (legacyScoreByKey.get(`${u.playerId}|${u.actionType}|${u.day}`) ?? null);

      if (u.rewardScore === nextScore) {
        if (nextScore !== null) filled += 1;
        continue;
      }

      await this.prisma.memoryUsage.update({
        where: { id: u.id },
        data: { rewardScore: nextScore },
      });
      if (nextScore !== null) filled += 1;
    }

    return filled;
  }
}
