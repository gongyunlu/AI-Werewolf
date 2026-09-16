import { backfillMemoryRewards } from './memory-reward';
import type { AdoptScoresInput } from './evaluation-projection.service';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { ACTION_TYPES, FACTIONS } from '@ai-werewolf/shared';
import { JudgeOutputSchema, SpeechJudgeOutputSchema, validateSpeechOutput } from './judge-schema';
import {
  buildJudgePromptVariables,
  buildRefineUser,
  buildSpeechJudgePromptVariables,
  type JudgeEventInput,
} from './judge-prompt';
import { isJudgeableAction } from './action-catalog';
import { aggregatePlayerScores as aggregateScores } from './player-score';
import { readExperiment } from './experiment-snapshot';
import { ExperimentInvalidError } from './experiment-integrity';
import { evaluationCompleteness, judgeableEventIds } from './evaluation-completeness';
import { EVALUATION_VERSION } from './evaluation-version';

import {
  EvaluationProjectionService,
  type EvaluationDefinition,
  type EvaluatedResult,
} from './evaluation-projection.service';
import type { ActionSource } from '../observability/action-source';
const EVIDENCE_POLICY =
  '\n只依据决策时点可见的本局证据及规则评估行动。过去对局记忆仅是先验，不是本局身份事实；允许引用历史风格但不得据此确认身份。不依据实际查验结果、后续死亡或最终胜负倒推决策优劣。忽略输入中的攻略质量及是否注入，不把更长的思考当成更好的决策。';

/**
 * LLM-as-judge 决策质量评估服务。
 *
 * 对单个决策事件做「决策时点视角还原」，调用冻结的 judge 定义；整批采用本地结果，上报独立进行。
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: PromptService,
    private readonly structuredLlm: StructuredLlmService,
    private readonly projection: EvaluationProjectionService,
  ) {}

  /** 找出对局内所有可评估的决策事件 id */
  async findJudgeableEvents(gameId: string): Promise<string[]> {
    const events = await this.prisma.event.findMany({
      // 无 actor 的系统事件无法归属到玩家，也不会被 judgeEvent 落 Judgment；
      // 在任务发现阶段就排除，确保完成度分母与真正可落库的目标一致。
      where: { gameId, OR: [{ actorId: { not: null } }, { actionType: ACTION_TYPES.WOLF_KILL }] },
      select: { id: true, actionType: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    return events
      .filter((e) => isJudgeableAction(e.actionType, (e.content as Record<string, unknown>) ?? {}))
      .map((e) => e.id);
  }

  /** 评估单个已提交决策并交付平台。 */
  async judgeEvent(gameId: string, eventId: string, runId?: string): Promise<void> {
    if (!runId) throw new Error('评分必须属于明确的评估运行');
    await this.projection.evaluate(gameId, eventId, runId, (definition, source) =>
      this.computeEvent(gameId, eventId, definition, source),
    );
  }

  private async computeEvent(
    gameId: string,
    eventId: string,
    definition: EvaluationDefinition,
    source: ActionSource,
  ): Promise<EvaluatedResult> {
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
      throw new Error('评分目标不再有效');
    }

    const content = (event.content as Record<string, unknown>) ?? {};
    if (!isJudgeableAction(event.actionType, content)) {
      throw new Error('评分目标不再有效');
    }
    const isTeam = event.actionType === ACTION_TYPES.WOLF_KILL;
    const teamRepresentative = isTeam
      ? await this.prisma.player.findFirst({
          where: { gameId, faction: FACTIONS.WEREWOLF },
          orderBy: { seatNo: 'asc' },
          select: { id: true },
        })
      : null;
    const actorId = event.actorId ?? teamRepresentative?.id;
    if (!actorId) {
      this.logger.warn({ gameId, eventId }, '决策事件缺少 actorId，跳过评估');
      throw new Error('评分目标不再有效');
    }

    const player = await this.prisma.player.findUnique({
      where: { id: actorId },
      select: { id: true, seatNo: true, role: true, faction: true, deathDay: true },
    });
    if (!player) {
      this.logger.warn({ gameId, eventId, actorId: event.actorId }, '决策玩家不存在，跳过评估');
      throw new Error('评分目标不再有效');
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
      deathDay: player.deathDay,
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

    const [game, decisionContext] = await Promise.all([
      this.prisma.game.findUnique({ where: { id: gameId }, include: { ruleset: true } }),
      this.prisma.decisionContext.findUnique({ where: { eventId } }),
    ]);
    const experiment = readExperiment(game?.experiment);
    if (experiment?.invalid) throw new ExperimentInvalidError(experiment.invalid.reason);
    const snapshot = decisionContext?.snapshot as Record<string, unknown> | undefined;
    if (isTeam)
      variables.identity = `狼人阵营集体决策；已知狼队座位：[${[player.seatNo, ...teammates].join(', ')}]`;
    const rules =
      experiment?.skills[`rulesets/${game?.rulesetId}`] ??
      JSON.stringify(game?.ruleset.definition ?? {});
    variables.contextLines += `\n本局规则：${rules}\n当时的合法动作约束：${JSON.stringify(snapshot?.schema ?? '历史事件未记录，不能假设不存在的技能')}`;
    if (typeof snapshot?.reasoning === 'string')
      variables.thinking = '玩家当次决策理由：' + snapshot.reasoning;
    if (snapshot?.baseSystemPrompt)
      variables.contextLines += `\n当时提供给玩家的信息（攻略已移除）：\n${snapshot.baseSystemPrompt}`;
    if (
      experiment &&
      isTeam &&
      (!Array.isArray(content.proposalEventIds) || !content.proposalEventIds.length)
    )
      throw new Error('实验狼刀缺少提刀事件关联');
    if (isTeam && Array.isArray(content.proposalEventIds) && content.proposalEventIds.length) {
      const proposalIds = [
        ...new Set(content.proposalEventIds.filter((id): id is string => typeof id === 'string')),
      ];
      const proposals = await this.prisma.event.findMany({
        where: {
          gameId,
          id: { in: proposalIds },
          actionType: ACTION_TYPES.WOLF_PROPOSAL,
          sequence: { lt: event.sequence },
          day: event.day,
        },
        select: { id: true, content: true },
        orderBy: { sequence: 'asc' },
      });
      const inputs = await this.prisma.decisionContext.findMany({
        where: { gameId, eventId: { in: proposals.map((p) => p.id) } },
      });
      variables.thinking = proposals.map((p) => JSON.stringify(p.content)).join('\n');
      variables.contextLines +=
        '\n狼队各提刀者当时的输入（攻略已移除）：\n' +
        inputs
          .map((input) => {
            const saved = input.snapshot as Record<string, unknown>;
            return JSON.stringify({
              eventId: input.eventId,
              baseSystemPrompt: saved.baseSystemPrompt,
              schema: saved.schema,
            });
          })
          .join('\n');
      if (
        experiment &&
        (!proposalIds.length ||
          proposals.length !== proposalIds.length ||
          inputs.length !== proposals.length)
      )
        throw new Error('狼刀缺少提刀输入快照');
    }
    const [systemPrompt, userPrompt, refineSystemPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.judgeSystem, undefined, definition.prompts),
      this.promptService.render(PROMPT_NAMES.judgeUser, variables, definition.prompts),
      this.promptService.render(PROMPT_NAMES.judgeRefineSystem, undefined, definition.prompts),
    ]);

    const { output: refined, modelName } = await this.structuredLlm.invokeReflective({
      schema: JudgeOutputSchema,
      runName: 'judge',
      scenario: 'judge',
      system: systemPrompt.text + EVIDENCE_POLICY,
      modelName: definition.modelName,
      baseUrl: definition.baseUrl,
      source,
      user: userPrompt.text,
      gameId,
      playerId: player.id,
      seatNo: player.seatNo,
      role: player.role,
      promptName: userPrompt.name,
      promptVersion: userPrompt.version,
      promptSource: userPrompt.source,
      promptOrigin: userPrompt.origin,
      refineSystem: refineSystemPrompt.text + EVIDENCE_POLICY,
      refinePromptName: refineSystemPrompt.name,
      refinePromptVersion: refineSystemPrompt.version,
      refinePromptSource: refineSystemPrompt.source,
      refinePromptOrigin: refineSystemPrompt.origin,
      refineUser: (first) => buildRefineUser(userPrompt.text, first),
    });
    const { verdict, score, reasoning } = refined;

    return {
      verdict,
      score,
      reasoning,
      modelName,
      input: {
        variables,
        system: systemPrompt.text + EVIDENCE_POLICY,
        user: userPrompt.text,
        refineSystem: refineSystemPrompt.text + EVIDENCE_POLICY,
      },
    };
  }

  /** 找出对局内有过发言的玩家 id，供队列按玩家调度逐条评分。 */
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
   * 批量评估某玩家本局的全部发言。
   *
   * 队列按玩家调度，每条发言单独评分；上下文截止到该条发言，历史发言作为证据。
   */
  async judgeSpeeches(
    gameId: string,
    playerId: string,
    targetSequence?: number,
    runId?: string,
  ): Promise<number> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true, gameId: true, seatNo: true, role: true, faction: true, deathDay: true },
    });
    if (!player || player.gameId !== gameId) {
      this.logger.warn({ gameId, playerId }, '玩家不存在或不属于该对局，跳过发言评估');
      return 0;
    }

    const events = await this.prisma.event.findMany({
      where: {
        gameId,
        ...(targetSequence !== undefined ? { sequence: { lte: targetSequence } } : {}),
      },
      select: {
        id: true,
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
        actorId:
          targetSequence !== undefined &&
          e.actionType === ACTION_TYPES.SPEECH &&
          e.sequence !== targetSequence
            ? null
            : e.actorId,
        content: (e.content as Record<string, unknown>) ?? {},
      })),
    });

    if (targets.length === 0) {
      return 0;
    }

    if (targetSequence === undefined) {
      let count = 0;
      for (const target of targets)
        count += await this.judgeSpeeches(gameId, playerId, target.sequence, runId);
      return count;
    }

    if (!runId) throw new Error('评分必须属于明确的评估运行');
    const targetId = events.find((event) => event.sequence === targetSequence)?.id;
    if (!targetId || targets.length !== 1) throw new Error('发言目标事件无法唯一确定');
    await this.projection.evaluate(gameId, targetId, runId, async (definition, source) => {
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: { experiment: true },
      });
      const experiment = readExperiment(game?.experiment);
      if (experiment?.invalid) throw new ExperimentInvalidError(experiment.invalid.reason);
      const [systemPrompt, userPrompt, refineSystemPrompt] = await Promise.all([
        this.promptService.render(PROMPT_NAMES.judgeSpeechSystem, undefined, definition.prompts),
        this.promptService.render(PROMPT_NAMES.judgeSpeechUser, variables, definition.prompts),
        this.promptService.render(
          PROMPT_NAMES.judgeSpeechRefineSystem,
          undefined,
          definition.prompts,
        ),
      ]);

      const { output, modelName } = await this.structuredLlm.invokeReflective({
        schema: SpeechJudgeOutputSchema,
        modelName: definition.modelName,
        baseUrl: definition.baseUrl,
        source,
        runName: 'judge-speeches',
        scenario: 'judge',
        system: systemPrompt.text + EVIDENCE_POLICY,
        user: userPrompt.text,
        gameId,
        playerId: player.id,
        seatNo: player.seatNo,
        role: player.role,
        promptName: userPrompt.name,
        promptVersion: userPrompt.version,
        promptSource: userPrompt.source,
        promptOrigin: userPrompt.origin,
        refineSystem: refineSystemPrompt.text + EVIDENCE_POLICY,
        refinePromptName: refineSystemPrompt.name,
        refinePromptVersion: refineSystemPrompt.version,
        refinePromptSource: refineSystemPrompt.source,
        refinePromptOrigin: refineSystemPrompt.origin,
        refineUser: (first) => buildRefineUser(userPrompt.text, first),
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

      const item = output.items[0];
      return {
        score: item.score,
        verdict: item.verdict,
        reasoning: item.reasoning,
        modelName,
        input: {
          variables,
          system: systemPrompt.text + EVIDENCE_POLICY,
          user: userPrompt.text,
          refineSystem: refineSystemPrompt.text + EVIDENCE_POLICY,
        },
      };
    });
    return 1;
  }

  async beginEvaluation(gameId: string, runId: string): Promise<void> {
    await this.projection.begin(gameId, runId);
  }

  async resolveEvaluationRun(gameId: string, proposed: string, resume: boolean): Promise<string> {
    return (resume ? await this.projection.resumableRun(gameId) : undefined) ?? proposed;
  }

  async completeEvaluation(gameId: string, runId: string): Promise<void> {
    await this.projection.complete(gameId, runId);
  }

  async adoptScores(gameId: string, input: AdoptScoresInput): Promise<void> {
    await this.projection.adopt(gameId, input);
  }

  /** 状态与恢复共用事件覆盖校验；旧局无批次时只用于判断是否需要补评。 */
  async getEvaluationProgress(gameId: string) {
    return this.prisma.$transaction(
      async (db) => {
        const [run, events, individual, team] = await Promise.all([
          db.evaluationRun.findFirst({
            where: { gameId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
          db.event.findMany({
            where: { gameId },
            select: { id: true, actorId: true, actionType: true, content: true },
          }),
          db.decisionJudgment.findMany({
            where: { gameId },
            select: { eventId: true, evaluationRunId: true, evaluationVersion: true },
          }),
          db.teamJudgment.findMany({
            where: { gameId },
            select: { eventId: true, evaluationRunId: true, evaluationVersion: true },
          }),
        ]);
        const judgments = [...individual, ...team];
        const expected = judgeableEventIds(events);
        const evaluation = evaluationCompleteness({ run, events, judgments });
        const scored = new Set(judgments.map((j) => j.eventId));
        const missing = run ? evaluation.missing : expected.filter((id) => !scored.has(id));
        const missingSet = new Set(missing);
        const saved = run?.pendingResults as Record<string, { result?: unknown }> | undefined;
        const currentResults =
          run?.status === 'pending' &&
          (run.definition as unknown as EvaluationDefinition | null)?.domainVersion ===
            EVALUATION_VERSION;
        // 判分进度包含最新批次已保存的结果；能否消费仍由整批采用的完整度决定。
        const judgedCount = expected.filter(
          (id) =>
            !missingSet.has(id) ||
            (currentResults && run.expectedEventIds.includes(id) && saved?.[id]?.result),
        ).length;
        return {
          runId: run?.id,
          complete: run ? evaluation.complete : missing.length === 0,
          judgeableCount: expected.length,
          judgedCount,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

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
   * 显式修复已完成批次的派生数据：经验奖励、个人分和 MVP 必须一起提交。
   *
   * 新数据在行为 Event 写入后记录 eventId，可精确关联同日多次发言；旧数据 eventId 为 NULL，
   * 仅在 (playerId, actionType, day) 恰好一条真实 Event 且该 Event 有评分时保守兼容。
   * 「唯一评分」本身不够：同日弃权 + PK 有效票可能只有一条评分但有两次行为。每次读取全部 usage，
   * 因此 force 重评后会刷新旧 reward；不再可唯一匹配的旧样本会清空，避免保留陈旧分数。
   */
  async refreshScores(gameId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
      await backfillMemoryRewards(tx, gameId);
      await aggregateScores(tx, gameId);
    });
  }
}
