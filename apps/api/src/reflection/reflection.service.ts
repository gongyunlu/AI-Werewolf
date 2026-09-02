import { Injectable, Logger } from '@nestjs/common';
import type { MemoryType } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { MemoryService, type CreateMemoryInput } from '../memory/memory.service';
import { ACTION_TYPES } from '@ai-werewolf/shared';
import { ReflectionOutputSchema } from './reflection-schema';
import { buildReflectionVariables, type TrustMisread } from './reflection-prompt';
import { GameReviewService } from './game-review.service';

const MEMORY_TYPE: Record<'reflection' | 'lesson' | 'playerModel', MemoryType> = {
  reflection: 'reflection',
  lesson: 'lesson',
  playerModel: 'player_model',
};

/** 反思产出的记忆来源标记，区别于 seed / manual */
const MEMORY_SOURCE = 'auto';

/**
 * player_model 使用乐观并发：发生竞争时在事务外基于最新快照重新生成。
 * 连续竞争超过上限则抛给 BullMQ 重试，避免无限消耗 LLM 调用。
 */
const PLAYER_MODEL_CAS_MAX_ATTEMPTS = 3;

type ExistingPlayerModelSnapshot = {
  /** 全部 active player_model 的稳定版本标识；包括元数据异常、未进入 prompt 的行。 */
  ids: string[];
  models: Array<{ agentName: string; content: string }>;
};

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * 玩家级赛后反思：把已被客观信号指出的失误，转成下一局能被检索、能被执行的经验。
 *
 * 输入的三段（对局复盘 / 客观误差 / 我的视角）里，客观误差是核心——
 * 让 LLM 自由复盘只会得到「运气差」「队友不配合」，锚定 judge 评分与识人偏差才能逼出可执行结论。
 */
@Injectable()
export class ReflectionService {
  private readonly logger = new Logger(ReflectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: PromptService,
    private readonly structuredLlm: StructuredLlmService,
    private readonly memoryService: MemoryService,
    private readonly gameReviewService: GameReviewService,
  ) {}

  /**
   * 为单个玩家生成反思并写入记忆。
   *
   * @param force - 已生成时是否重跑；重跑会先软删除本局旧记忆，避免新旧两套经验并存
   * @returns 写入的记忆条数，跳过时为 0
   */
  async reflect(gameId: string, playerId: string, force = false): Promise<number> {
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        gameId: true,
        agentId: true,
        seatNo: true,
        role: true,
        faction: true,
        deathDay: true,
        memoryLabelSnapshot: true,
        agent: { select: { name: true } },
      },
    });
    if (!player || player.gameId !== gameId) {
      this.logger.warn({ gameId, playerId }, '玩家不存在或不属于该对局，跳过反思');
      return 0;
    }

    const performance = await this.prisma.agentPerformance.findUnique({
      where: { gameId_playerId: { gameId, playerId } },
      select: {
        survivalDays: true,
        isWinner: true,
        voteAccuracy: true,
        speechCount: true,
        reflectionGenerated: true,
      },
    });

    if (!performance) {
      // 结算必须先产出表现记录。这里抛错让 BullMQ 有界重试，避免白跑一次 LLM，
      // 也避免记录恰在 LLM 期间出现时用“第 0 天”等不完整输入领取写入权。
      throw new Error(`Game ${gameId} player ${playerId} 尚无表现记录，无法生成玩家反思`);
    }

    if (performance.reflectionGenerated && !force) {
      this.logger.log({ gameId, playerId }, '反思已生成，跳过');
      return 0;
    }

    const review = await this.gameReviewService.loadReview(gameId);
    if (!review) {
      throw new Error(`Game ${gameId} 尚无对局复盘，无法生成玩家反思`);
    }

    const [others, myJudgments, mySpeechEvents, trustMisreads, initialModelSnapshot] =
      await Promise.all([
        this.loadOpponents(gameId, playerId),
        this.prisma.decisionJudgment.findMany({
          where: { gameId, playerId },
          select: {
            playerId: true,
            actionType: true,
            day: true,
            targetSeatNo: true,
            verdict: true,
            score: true,
            reasoning: true,
          },
          orderBy: { day: 'asc' },
        }),
        this.prisma.event.findMany({
          where: { gameId, actorId: playerId, actionType: ACTION_TYPES.SPEECH },
          select: { day: true, phase: true, visibility: true, content: true },
          orderBy: { sequence: 'asc' },
        }),
        this.loadTrustMisreads(gameId, player.agentId),
        this.loadExistingPlayerModelSnapshot(player.agentId, player.memoryLabelSnapshot),
      ]);

    const label = player.memoryLabelSnapshot;
    const opponentByName = new Map(others.map((o) => [o.agentName, o]));
    const systemPromptPromise = this.promptService.render(PROMPT_NAMES.reflectionSystem);
    let modelSnapshot = initialModelSnapshot;

    for (let attempt = 1; attempt <= PLAYER_MODEL_CAS_MAX_ATTEMPTS; attempt += 1) {
      const variables = buildReflectionVariables({
        me: {
          playerId: player.id,
          seatNo: player.seatNo,
          agentName: player.agent.name,
          role: player.role ?? '',
          faction: player.faction ?? '',
          deathDay: player.deathDay,
          isWinner: performance.isWinner,
        },
        opponents: others,
        review: { narrative: review.narrative, turningPoints: review.turningPoints },
        myJudgments,
        // 硬约束：只取自己的发言与自己的思考，他人的内心推理经由复盘间接给出
        mySpeeches: mySpeechEvents.map((e) => {
          const content = (e.content as Record<string, unknown>) ?? {};
          return {
            day: e.day,
            phase: e.phase,
            visibility: e.visibility,
            speech: typeof content.speech === 'string' ? content.speech : '',
            thinking: typeof content.thinking === 'string' ? content.thinking : undefined,
          };
        }),
        trustMisreads,
        performance: {
          survivalDays: performance.survivalDays,
          isWinner: performance.isWinner,
          voteAccuracy: performance.voteAccuracy,
          speechCount: performance.speechCount,
        },
        existingModels: modelSnapshot.models,
      });

      const [systemPrompt, userPrompt] = await Promise.all([
        systemPromptPromise,
        this.promptService.render(PROMPT_NAMES.reflectionUser, variables),
      ]);
      const { output } = await this.structuredLlm.invoke({
        schema: ReflectionOutputSchema,
        runName: 'reflection',
        scenario: 'reflection',
        system: systemPrompt.text,
        user: userPrompt.text,
        gameId,
        playerId,
        seatNo: player.seatNo,
        role: player.role,
        promptName: userPrompt.name,
        promptVersion: userPrompt.version,
      });

      // 只接受名单内的对手，防止模型编造出不存在的 Agent
      const validModels = output.playerModels.filter((model) =>
        opponentByName.has(model.agentName),
      );
      const inputs: CreateMemoryInput[] = [
        {
          agentId: player.agentId,
          label,
          gameId,
          type: MEMORY_TYPE.reflection,
          title: `第 ${performance.survivalDays} 天出局的${player.role ?? ''}复盘`,
          content: output.summary,
          importance: 0.3, // 复盘全文只作提炼原料与人工查阅，不参与注入
          source: MEMORY_SOURCE,
        },
        ...output.lessons.map((lesson) => ({
          agentId: player.agentId,
          label,
          gameId,
          type: MEMORY_TYPE.lesson,
          title: lesson.title,
          // 正文只放 trigger + action：trigger 供 embedding 做场景匹配，action 供注入时执行。
          // evidence 是本局座位绑定的事实，写进正文会污染下一局（读到「4号是狼」易致幻觉），
          // 只留在 metadata 里供事后归因。
          content: `当${lesson.trigger}时：${lesson.action}`,
          importance: lesson.importance,
          source: MEMORY_SOURCE,
          metadata: {
            trigger: lesson.trigger,
            action: lesson.action,
            evidence: lesson.evidence,
            role: lesson.role,
            scenario: lesson.scenario,
          },
        })),
        ...validModels.map((model) => ({
          agentId: player.agentId,
          label,
          gameId,
          type: MEMORY_TYPE.playerModel,
          title: `对手建模：${model.agentName}`,
          content: model.content,
          confidence: model.confidence,
          source: MEMORY_SOURCE,
          metadata: {
            targetAgentId: opponentByName.get(model.agentName)!.agentId,
            targetAgentName: model.agentName,
          },
        })),
      ];
      const targetAgentIds = validModels.map(
        (model) => opponentByName.get(model.agentName)!.agentId,
      );

      const persisted = await this.prisma.$transaction(async (tx) => {
        // 所有自动反思写入都遵守同一 agent+label 锁；锁内重读版本，防止两个跨局任务
        // 都基于同一份旧建模生成后发生 last-writer-wins 丢失更新。
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${`${player.agentId}|${label}`}, 0)) IS NULL AS locked
        `;
        const currentModels = await tx.memory.findMany({
          where: { agentId: player.agentId, label, type: MEMORY_TYPE.playerModel, isActive: true },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (
          !sameIds(
            modelSnapshot.ids,
            currentModels.map((model) => model.id),
          )
        ) {
          return { status: 'stale' as const };
        }

        // CAS 通过后才领取写入权；stale 分支不改变 reflectionGenerated，也不软删除任何记忆。
        const claim = await tx.agentPerformance.updateMany({
          where: {
            gameId,
            playerId,
            ...(!force ? { reflectionGenerated: false } : {}),
          },
          data: { reflectionGenerated: true },
        });
        if (claim.count === 0) return { status: 'skipped' as const };

        if (force) {
          // 只替换本流程在当前标签下生成的三类记忆，保留同局 manual/seed/refined 记忆。
          await tx.memory.updateMany({
            where: {
              gameId,
              agentId: player.agentId,
              label,
              source: MEMORY_SOURCE,
              type: { in: Object.values(MEMORY_TYPE) },
              isActive: true,
            },
            data: { isActive: false },
          });
        }
        // 每个对手只保留一条活跃建模：新建模覆盖旧的，旧的软删除保留溯源
        if (targetAgentIds.length > 0) {
          await tx.memory.updateMany({
            where: {
              agentId: player.agentId,
              label,
              type: MEMORY_TYPE.playerModel,
              isActive: true,
              OR: targetAgentIds.map((id) => ({
                metadata: { path: ['targetAgentId'], equals: id },
              })),
            },
            data: { isActive: false },
          });
        }

        const rows = await this.memoryService.createMemories(inputs, tx);
        return { status: 'created' as const, rows };
      });

      if (persisted.status === 'stale') {
        if (attempt === PLAYER_MODEL_CAS_MAX_ATTEMPTS) {
          throw new Error(
            `Agent ${player.agentId} 的 player_model 连续发生并发更新，已超过 ${PLAYER_MODEL_CAS_MAX_ATTEMPTS} 次重试`,
          );
        }
        this.logger.warn(
          { gameId, playerId, attempt },
          'player_model 快照已变化，将在事务外基于最新建模重新生成反思',
        );
        modelSnapshot = await this.loadExistingPlayerModelSnapshot(player.agentId, label);
        continue;
      }

      if (persisted.status === 'skipped') {
        this.logger.log({ gameId, playerId }, '反思已由其他任务生成或缺少表现记录，跳过写入');
        return 0;
      }

      if (validModels.length < output.playerModels.length) {
        this.logger.warn(
          { gameId, playerId, dropped: output.playerModels.length - validModels.length },
          '反思输出的对手建模不在同桌名单内，已丢弃',
        );
      }
      // 事务外补向量：失败不回滚正文，回填命令会捞起补
      await this.memoryService.embedMemories(persisted.rows);
      this.logger.log(
        {
          gameId,
          playerId,
          lessons: output.lessons.length,
          playerModels: validModels.length,
        },
        '玩家反思完成',
      );
      return persisted.rows.length;
    }

    throw new Error('player_model CAS 重试状态异常');
  }

  /** 同桌对手的真实身份；反思是开眼的，对手建模要建立在真实身份之上 */
  private async loadOpponents(gameId: string, playerId: string) {
    const rows = await this.prisma.player.findMany({
      where: { gameId, id: { not: playerId } },
      select: {
        agentId: true,
        seatNo: true,
        role: true,
        faction: true,
        agent: { select: { name: true } },
      },
      orderBy: { seatNo: 'asc' },
    });

    return rows.map((p) => ({
      agentId: p.agentId,
      agentName: p.agent.name,
      seatNo: p.seatNo,
      role: p.role ?? '',
      faction: p.faction ?? '',
    }));
  }

  /** 该 Agent 局内对每个座位的最后一次信任判断，配上真实阵营 */
  private async loadTrustMisreads(gameId: string, agentId: string): Promise<TrustMisread[]> {
    const [judgments, players] = await Promise.all([
      this.prisma.agentJudgment.findMany({
        where: { gameId, agentId },
        select: {
          id: true,
          speakerSeatNo: true,
          trustScore: true,
          suspicious: true,
          relationship: true,
          createdAt: true,
          speechEvent: { select: { sequence: true } },
        },
      }),
      this.prisma.player.findMany({
        where: { gameId },
        select: { seatNo: true, faction: true, agent: { select: { name: true } } },
      }),
    ]);

    const playerBySeat = new Map(
      players.filter((p) => p.seatNo !== null).map((p) => [p.seatNo!, p]),
    );
    // 同一座位可能在同一天被判断多次。事件 sequence 是对局内严格顺序，
    // createdAt 与 id 作为防御性 tie-breaker，避免依赖数据库未指定的返回顺序。
    const latestBySeat = new Map<number, (typeof judgments)[number]>();
    const orderedJudgments = judgments.toSorted(
      (a, b) =>
        a.speechEvent.sequence - b.speechEvent.sequence ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    for (const j of orderedJudgments) {
      latestBySeat.set(j.speakerSeatNo, j);
    }

    return [...latestBySeat.values()]
      .map((j) => {
        const target = playerBySeat.get(j.speakerSeatNo);
        if (!target) return null;
        return {
          seatNo: j.speakerSeatNo,
          agentName: target.agent.name,
          trustScore: j.trustScore,
          suspicious: j.suspicious,
          actualFaction: target.faction ?? '',
          relationship: j.relationship,
        };
      })
      .filter((t): t is TrustMisread => t !== null);
  }

  /** 该 Agent 此前的 active player_model + 版本快照，供增量更新与写前 CAS。 */
  private async loadExistingPlayerModelSnapshot(
    agentId: string,
    label: string,
  ): Promise<ExistingPlayerModelSnapshot> {
    const rows = await this.prisma.memory.findMany({
      where: { agentId, label, type: MEMORY_TYPE.playerModel, isActive: true },
      select: { id: true, content: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const models = rows
      .map((r) => {
        const metadata = (r.metadata as Record<string, unknown> | null) ?? {};
        const agentName =
          typeof metadata.targetAgentName === 'string' ? metadata.targetAgentName : '';
        return agentName ? { agentName, content: r.content } : null;
      })
      .filter((m): m is { agentName: string; content: string } => m !== null);

    return { ids: rows.map((row) => row.id).toSorted(), models };
  }
}
