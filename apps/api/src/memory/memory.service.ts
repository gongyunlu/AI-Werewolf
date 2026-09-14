import { lessonApplies } from './lesson-applicability';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PERSONA_IMPORTANCE,
  PERSONA_STRATEGY_TYPES,
  STRATEGY_IMPORTANCE,
  type PersonaStrategyItem,
} from './persona-strategy';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { MemoryType } from '@ai-werewolf/shared';
import { Prisma } from '../generated/prisma/client';
import { EmbeddingService } from './embedding.service';
import { computeLessonCandidateScore, computeLessonRank, type LessonHit } from './lesson-rank';
import { retrieveFrozenMemories, type FrozenMemory } from '../evaluation/experiment-snapshot';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';
import { CURRENT_LEARNING_USAGE_FILTER } from './learning-usage-filter';

/** memories.label 的列长，接口参数与之对齐 */
const MEMORY_LABEL_MAX_LENGTH = 128;

export type ActiveMemory = Prisma.MemoryGetPayload<{
  select: {
    id: true;
    type: true;
    title: true;
    content: true;
    importance: true;
  };
}>;

/** 语义检索结果：在 ActiveMemory 基础上附带与 query 的余弦相似度 */
export type SimilarMemory = ActiveMemory & { similarity: number; metadata?: unknown };

export type RetrieveSimilarOptions = {
  /** 指定类型集合，缺省不过滤 */
  types?: MemoryType[];
  /** 每次取多少条，默认 20 */
  limit?: number;
  /** 是否累加 retrievalCount，默认 true；注入路径传 false */
  trackRetrieval?: boolean;
  /** 适用角色硬过滤：只返回 metadata.role 等于该值或 any 的记忆（缺省不过滤） */
  role?: string;
  /** 适用场景硬过滤：只返回 metadata.scenario 等于该值或 any 的记忆（缺省不过滤） */
  scenario?: string;
};

export type RetrieveActiveMemoriesOptions = {
  types?: MemoryType[]; // 指定类型集合，缺省不过滤
  limit?: number; // 每次取多少条，默认 20
  /**
   * 是否累加 retrievalCount，默认 true。
   * 局内注入路径传 false：单局有数十次注入，计数会退化成「决策次数」而非「记忆被用过几次」。
   */
  trackRetrieval?: boolean;
};

/** 新建记忆的入参 */
export type CreateMemoryInput = {
  agentId: string;
  label: string;
  type: MemoryType;
  title: string;
  content: string;
  gameId?: string | null;
  eventId?: string | null;
  importance?: number;
  confidence?: number;
  source?: string;
  metadata?: Prisma.InputJsonValue;
};

/** 已落库、待补向量的记忆 */
export type CreatedMemory = { id: string; content: string };

/** 人设/策略的整批写入口径；不含 importance，分层由 type 决定 */
export type PersonaStrategyInput = {
  persona: PersonaStrategyItem[];
  strategy: PersonaStrategyItem[];
};

/** 人设/策略的读接口形态 */
export type PersonaStrategyRow = {
  id: string;
  type: string;
  title: string;
  content: string;
  importance: number;
};

export type PersonaStrategyView = {
  label: string;
  persona: PersonaStrategyRow[];
  strategy: PersonaStrategyRow[];
};

export type BackfillEmbeddingsOptions = {
  /** 每次从数据库领取的最大记录数；EmbeddingService 内部仍按供应商上限拆批。 */
  batchSize?: number;
  /** 本次命令最多处理多少条，缺省处理完全部 active Memory。 */
  limit?: number;
};

export function hashMemoryContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toActiveMemory(row: {
  id: string;
  type: string;
  title: string;
  content: string;
  importance: number;
}): ActiveMemory {
  return {
    id: row.id,
    type: row.type as MemoryType,
    title: row.title,
    content: row.content,
    importance: row.importance,
  };
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  async captureExperimentMemories(agentIds: string[]): Promise<FrozenMemory[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<FrozenMemory & { vector: string | null }>>`
        SELECT m.id, m.agent_id AS "agentId", m.label, m.type, m.title, m.content, m.importance,
               m.metadata, m.created_at::text AS "createdAt",
               CASE WHEN m.embedding_model = ${this.embeddingService.model} THEN m.embedding::text ELSE NULL END AS vector
        FROM memories m JOIN agents a ON a.id = m.agent_id AND a.memory_label = m.label
        WHERE m.agent_id IN (${Prisma.join(agentIds)}) AND m.is_active = true
      `;
        const hits = await tx.$queryRaw<
          Array<{ memoryId: string; agentId: string; actionType: string; reward: number }>
        >`
        SELECT u.memory_id AS "memoryId", m.agent_id AS "agentId", u.action_type AS "actionType", u.reward_score AS reward
        FROM memory_usages u JOIN memories m ON m.id = u.memory_id
        WHERE m.agent_id IN (${Prisma.join(agentIds)}) AND m.type = 'lesson'
          ${CURRENT_LEARNING_USAGE_FILTER}
      `;
        const baselines = await tx.decisionJudgment.groupBy({
          where: {
            evaluationVersion: EVALUATION_VERSION,
            game: { experiment: { equals: Prisma.DbNull } },
          },
          by: ['actionType'],
          _avg: { score: true },
        });
        const baselineByActionType = new Map(
          baselines.map((b) => [b.actionType, b._avg.score ?? 50]),
        );
        const values = [...baselineByActionType.values()];
        const defaultBaseline = values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : 50;
        return rows.map(({ vector, ...row }) =>
          Object.assign(row, {
            metadata: row.metadata ?? {},
            embedding: vector ? (JSON.parse(vector) as number[]) : null,
            rank: computeLessonRank({
              hits: hits.filter((h) => h.memoryId === row.id),
              baselineByActionType,
              defaultBaseline,
              totalHits: hits.filter((h) => h.agentId === row.agentId).length,
              importance: row.importance,
            }),
          }),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async retrieveFrozen(
    snapshot: { memories: FrozenMemory[]; embeddingModel: string },
    input: {
      agentId: string;
      label: string;
      opponentAgentIds: string[];
      role: string | null;
      scenario: string;
      query: string;
      facts?: string[];
    },
  ) {
    if (snapshot.embeddingModel !== this.embeddingService.model)
      throw new Error('实验 embedding 模型已改变，请创建新实验');
    const queryVector = await this.embeddingService.embedText(input.query);
    return retrieveFrozenMemories(snapshot.memories, { ...input, queryVector });
  }

  /**
   * 检索指定 agent 的指定 label 的所有 active memory，按 importance 降序、createdAt 升序排序。
   * @param agentId
   * @param label
   * @param opts
   * @returns
   */
  async retrieveActiveMemories(
    agentId: string,
    label: string,
    opts: RetrieveActiveMemoriesOptions = {},
  ): Promise<ActiveMemory[]> {
    const rows = await this.prisma.memory.findMany({
      where: {
        agentId,
        label,
        isActive: true,
        ...(opts.types && opts.types.length > 0 ? { type: { in: opts.types } } : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
      take: opts.limit ?? 20,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        importance: true,
      },
    });

    // 热度追踪：被检索到的记忆累加 retrievalCount 并刷新 lastRetrievedAt
    if (rows.length > 0 && opts.trackRetrieval !== false) {
      await this.prisma.memory.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { retrievalCount: { increment: 1 }, lastRetrievedAt: new Date() },
      });
    }

    return rows.map((r) => ({
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      content: r.content,
      importance: r.importance,
    }));
  }

  /** label 缺省时用 Agent 当前的记忆集；Agent 不存在则明确报错，避免写进一个孤儿 label。 */
  private async resolveMemoryLabel(agentId: string, label?: string): Promise<string> {
    // 超长 label 会先撞上 Postgres 的列长限制报 500，这里按参数错误挡回去
    if (label && label.length > MEMORY_LABEL_MAX_LENGTH) {
      throw new BadRequestException(`label 不能超过 ${MEMORY_LABEL_MAX_LENGTH} 字符`);
    }
    if (label) return label;
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { memoryLabel: true },
    });
    if (!agent) throw new NotFoundException(`Agent ${agentId} 不存在`);
    return agent.memoryLabel;
  }

  /** 读取 Agent 在某记忆集下的人设与策略，供管理界面展示与编辑。 */
  async readPersonaStrategy(agentId: string, label?: string): Promise<PersonaStrategyView> {
    const resolved = await this.resolveMemoryLabel(agentId, label);
    const rows = await this.prisma.memory.findMany({
      where: {
        agentId,
        label: resolved,
        type: { in: [...PERSONA_STRATEGY_TYPES] },
        isActive: true,
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, type: true, title: true, content: true, importance: true },
    });
    return {
      label: resolved,
      persona: rows.filter((row) => row.type === 'persona'),
      strategy: rows.filter((row) => row.type === 'strategy'),
    };
  }

  /**
   * 整批替换 Agent 在某记忆集下的人设与策略。
   *
   * 旧条目只归档不删除：历史对局的 MemoryUsage 仍要指得到它们。
   * 这两类记忆按 type 过滤读取而非语义检索，所以不生成 embedding，
   * 5 个向量列全留 NULL 即满足表上「同 NULL 或同非 NULL」的约束。
   */
  async replacePersonaStrategy(
    agentId: string,
    label: string | undefined,
    input: PersonaStrategyInput,
  ): Promise<PersonaStrategyView> {
    const resolved = await this.resolveMemoryLabel(agentId, label);
    const rows = [
      ...input.persona.map((item) => ({
        ...item,
        type: 'persona' as const,
        importance: PERSONA_IMPORTANCE,
      })),
      ...input.strategy.map((item) => ({
        ...item,
        type: 'strategy' as const,
        importance: STRATEGY_IMPORTANCE,
      })),
    ];
    await this.prisma.$transaction(async (tx) => {
      await tx.memory.updateMany({
        where: {
          agentId,
          label: resolved,
          type: { in: [...PERSONA_STRATEGY_TYPES] },
          isActive: true,
        },
        data: { isActive: false },
      });
      if (rows.length > 0) {
        await tx.memory.createMany({
          data: rows.map((row) => ({ agentId, label: resolved, source: 'manual', ...row })),
        });
      }
    });
    return this.readPersonaStrategy(agentId, resolved);
  }

  /**
   * 检索可注入决策的经验记忆。
   *
   * 不与 persona/strategy 合并成一次检索：那是按 importance 全局混排的，
   * 经验积累起来会把人设与策略挤出窗口。两类记忆的注入策略也不同——
   * lesson 无界增长只取 topK，player_model 每个对手至多一条、按同桌过滤后全注入。
   *
   * 走注入路径，不累加 retrievalCount。
   */
  async retrieveExperience(options: {
    agentId: string;
    label: string;
    /** 本局同桌对手的 agentId，用于过滤对手建模 */
    opponentAgentIds: string[];
    /** 当前局面描述，与 lesson 的 trigger 做语义匹配 */
    query: string;
    /** 当前角色，硬过滤掉不适用的 lesson；null 时跳过角色过滤（防御性，正常玩家必有角色） */
    role: string | null;
    /** 当前场景，硬过滤掉不适用的 lesson */
    scenario: string;
    facts?: string[];
    lessonLimit?: number;
  }): Promise<{ lessons: SimilarMemory[]; playerModels: ActiveMemory[] }> {
    const { agentId, label, opponentAgentIds, query, role, scenario } = options;
    const select = {
      id: true,
      type: true,
      title: true,
      content: true,
      importance: true,
      metadata: true,
    };
    const lessonLimit = options.lessonLimit ?? 3;

    const playerModelsPromise =
      opponentAgentIds.length > 0
        ? this.prisma.memory.findMany({
            where: {
              agentId,
              label,
              isActive: true,
              type: 'player_model',
              OR: opponentAgentIds.map((id) => ({
                metadata: { path: ['targetAgentId'], equals: id },
              })),
            },
            orderBy: { createdAt: 'desc' },
            select,
          })
        : Promise.resolve([]);

    // lesson 的向量化服务属于学习增强能力，故障时必须降级为空，不能让玩家跳过发言或被迫弃票。
    // player_model 只走数据库查询，与向量服务解耦，仍应正常注入。
    const lessonsPromise = (async (): Promise<SimilarMemory[]> => {
      try {
        // 语义检索取候选（扩到 20 供质量分重排），再按 similarity × rank 收敛到 lessonLimit
        const candidates = await this.retrieveBySimilarity(agentId, label, query, {
          types: ['lesson'],
          limit: 20,
          // 注入路径不累加热度：单局数十次检索会让 retrievalCount 退化成「决策次数」
          trackRetrieval: false,
          role: role ?? undefined,
          scenario,
        });
        return await this.rankLessons(
          candidates.filter((m) => lessonApplies(m.metadata, options.facts ?? [])),
          agentId,
          lessonLimit,
        );
      } catch (error) {
        this.logger.warn(
          {
            agentId,
            scenario,
            err: error instanceof Error ? error.message : String(error),
          },
          '经验 lesson 检索失败，已降级为空经验',
        );
        return [];
      }
    })();

    const [lessons, playerModelRows] = await Promise.all([lessonsPromise, playerModelsPromise]);

    // createdAt desc 已把最新记录放在前面；即使历史并发曾留下多条 active 建模，
    // 注入端也按 targetAgentId 只取一条，避免重复内容挤占上下文。
    const seenTargets = new Set<string>();
    const playerModels = playerModelRows.filter((row) => {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const targetAgentId =
        typeof metadata.targetAgentId === 'string' ? metadata.targetAgentId : row.id;
      if (seenTargets.has(targetAgentId)) return false;
      seenTargets.add(targetAgentId);
      return true;
    });

    return { lessons, playerModels: playerModels.map(toActiveMemory) };
  }

  /**
   * 质量分重排：候选 lesson 按 similarity × rank 排序取 topK。
   *
   * rank 由命中样本相对同 actionType 基线的 lift 经贝叶斯收缩 + UCB 探索算出；
   * 无命中样本的冷启动 lesson 退回 importance 先验。候选为空时直接返回空，省掉聚合查询。
   */
  private async rankLessons(
    candidates: SimilarMemory[],
    agentId: string,
    topK: number,
  ): Promise<SimilarMemory[]> {
    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((m) => m.id);

    // 命中样本 + 全局基线 + 该 agent 命中总数，一次并行取回
    const [hits, baselineRows, totalHitsRow] = await Promise.all([
      this.prisma.$queryRaw<Array<{ memoryId: string; actionType: string; rewardScore: number }>>`
        SELECT u.memory_id AS "memoryId", u.action_type AS "actionType", u.reward_score AS "rewardScore"
        FROM memory_usages u
        WHERE u.memory_id IN (${Prisma.join(candidateIds)})
          ${CURRENT_LEARNING_USAGE_FILTER}
      `,
      this.prisma.decisionJudgment.groupBy({
        where: {
          evaluationVersion: EVALUATION_VERSION,
          game: { experiment: { equals: Prisma.DbNull } },
        },
        by: ['actionType'],
        _avg: { score: true },
      }),
      this.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM memory_usages u
        JOIN memories m ON m.id = u.memory_id
        WHERE m.agent_id = ${agentId}::uuid
          AND m.type = 'lesson'
          ${CURRENT_LEARNING_USAGE_FILTER}
      `,
    ]);

    // 各 actionType 基线；未登记行为用各基线的算术平均兜底
    const baselineByActionType = new Map<string, number>();
    for (const row of baselineRows) {
      const avg = row._avg.score;
      if (avg == null) continue;
      baselineByActionType.set(row.actionType, avg);
    }
    const baselines = [...baselineByActionType.values()];
    const defaultBaseline =
      baselines.length > 0 ? baselines.reduce((a, b) => a + b, 0) / baselines.length : 50;

    // 命中样本按 lesson 分组
    const hitsByMemory = new Map<string, LessonHit[]>();
    for (const h of hits) {
      if (h.rewardScore == null) continue;
      const list = hitsByMemory.get(h.memoryId);
      const hit = { actionType: h.actionType, reward: h.rewardScore };
      if (list) list.push(hit);
      else hitsByMemory.set(h.memoryId, [hit]);
    }

    const totalHits = totalHitsRow[0]?.count ?? 0;

    return (
      candidates
        .map((m) => ({
          memory: m,
          score: computeLessonCandidateScore(
            m.similarity,
            computeLessonRank({
              hits: hitsByMemory.get(m.id) ?? [],
              baselineByActionType,
              defaultBaseline,
              totalHits,
              importance: m.importance,
            }),
          ),
        }))
        // 非正相似度由 computeLessonCandidateScore 标成 -Infinity；必须在 slice 前剔除，
        // 否则有效候选不足 topK 时仍会把完全不相关的 lesson 补进上下文。
        .filter(({ score }) => Number.isFinite(score))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ memory }) => memory)
    );
  }

  /**
   * 批量写入记忆正文。
   *
   * 只写正文，5 个 embedding 列保持 NULL（满足表上「同 NULL 或同非 NULL」的 CHECK 约束）；
   * 向量由调用方在事务外用 {@link embedMemories} 补写，失败不回滚正文，
   * `pnpm memory:backfill-embeddings` 会捞起补。
   */
  async createMemories(
    inputs: CreateMemoryInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<CreatedMemory[]> {
    const client = tx ?? this.prisma;
    const created: CreatedMemory[] = [];

    for (const input of inputs) {
      const row = await client.memory.create({
        data: {
          agentId: input.agentId,
          label: input.label,
          gameId: input.gameId ?? null,
          eventId: input.eventId ?? null,
          type: input.type,
          title: input.title,
          content: input.content,
          ...(input.importance !== undefined ? { importance: input.importance } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
        select: { id: true, content: true },
      });
      created.push(row);
    }

    return created;
  }

  /** 为刚写入的记忆补 embedding；整批失败只记日志，不抛出（正文已落库，可由回填命令补） */
  async embedMemories(memories: CreatedMemory[]): Promise<number> {
    if (memories.length === 0) return 0;

    try {
      const vectors = await this.embeddingService.embedTexts(memories.map((m) => m.content));
      let done = 0;
      for (let i = 0; i < memories.length; i++) {
        await this.embedAndStore(memories[i].id, vectors[i], memories[i].content);
        done += 1;
      }
      return done;
    } catch (error) {
      this.logger.warn(
        { count: memories.length, err: error instanceof Error ? error.message : String(error) },
        '记忆向量写入失败，正文已落库，可用回填命令补齐',
      );
      return 0;
    }
  }

  /**
   * 记录一次注入用到了哪些记忆，供事后按行为评分做质量归因。
   *
   * 属于学习链路的观测数据，写失败只记日志不打断对局。
   */
  async recordUsages(
    rows: Array<{
      memoryId: string;
      gameId: string;
      playerId: string;
      eventId: string;
      scenario: string;
      actionType: string;
      day: number;
      triggerMatched?: boolean;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;

    try {
      await this.prisma.memoryUsage.createMany({ data: rows, skipDuplicates: true });
    } catch (error) {
      this.logger.warn(
        { count: rows.length, err: error instanceof Error ? error.message : String(error) },
        '记忆注入记录写入失败',
      );
    }
  }

  /** 软删除某 agent 在某局产生的记忆，用于重跑反思时避免新旧并存 */
  async deactivateGameMemories(
    gameId: string,
    agentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    const { count } = await client.memory.updateMany({
      where: { gameId, agentId, isActive: true },
      data: { isActive: false },
    });
    return count;
  }

  /**
   * 语义检索：基于 query 的 embedding 与记忆 embedding 的余弦距离排序，返回余弦相似度。
   */
  async retrieveBySimilarity(
    agentId: string,
    label: string,
    query: string,
    options: RetrieveSimilarOptions = {},
  ): Promise<SimilarMemory[]> {
    const { types, limit = 20, trackRetrieval = true, role, scenario } = options;
    const queryVec = await this.embeddingService.embedText(query);
    const typeFilter =
      types && types.length > 0 ? Prisma.sql`AND type IN (${Prisma.join(types)})` : Prisma.empty;
    // 硬过滤：角色/场景是 trigger 的可枚举硬条件，embedding 区分不了（「我是平民」vs「我是预言家」相似度仍高），
    // 必须在 SQL 层精确匹配，否则平民会拿到神职专属 lesson。缺字段的旧数据在完成回填前不注入，
    // 不能把「未知适用范围」静默扩大成 any。
    const roleFilter = role
      ? Prisma.sql`AND (metadata->>'role' = ${role} OR metadata->>'role' = 'any')`
      : Prisma.empty;
    const scenarioFilter = scenario
      ? Prisma.sql`AND (metadata->>'scenario' = ${scenario} OR metadata->>'scenario' = 'any')`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        title: string;
        content: string;
        importance: number;
        similarity: number;
        metadata: unknown;
      }>
    >`
      SELECT id, type, title, content, importance, metadata,
             1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS similarity
      FROM memories
      WHERE agent_id = ${agentId}::uuid
        AND label = ${label}
        AND is_active = true
        AND embedding IS NOT NULL
        AND embedding_model = ${this.embeddingService.model}
        AND embedding_dimension = ${this.embeddingService.dimension}
        ${typeFilter}
        ${roleFilter}
        ${scenarioFilter}
      ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
      LIMIT ${limit}
    `;

    if (rows.length > 0 && trackRetrieval) {
      await this.prisma.memory.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { retrievalCount: { increment: 1 }, lastRetrievedAt: new Date() },
      });
    }

    return rows.map((r) => ({
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      content: r.content,
      importance: r.importance,
      similarity: r.similarity,
      metadata: r.metadata,
    }));
  }

  /** 写入单条记忆的 embedding 向量 */
  async embedAndStore(memoryId: string, vector: number[], expectedContent?: string): Promise<void> {
    this.embeddingService.assertValidVector(vector);

    const content =
      expectedContent ??
      (
        await this.prisma.memory.findUnique({
          where: { id: memoryId },
          select: { content: true },
        })
      )?.content;
    if (content === undefined) {
      throw new Error(`找不到待写入 embedding 的 Memory: ${memoryId}`);
    }

    const updated = await this.prisma.$executeRaw`
      UPDATE memories
      SET embedding = ${JSON.stringify(vector)}::vector,
          embedding_model = ${this.embeddingService.model},
          embedding_dimension = ${this.embeddingService.dimension},
          embedding_content_hash = ${hashMemoryContent(content)},
          embedded_at = NOW()
      WHERE id = ${memoryId}::uuid
        AND content = ${content}
    `;
    if (updated !== 1) {
      throw new Error(`Memory ${memoryId} 的内容在向量生成期间发生变化，请重试`);
    }
  }

  /**
   * 分批回填 active Memory；每条成功后立即落库，失败后可安全重跑。
   *
   * 人设与策略按 type 直读、不参与语义检索，跳过它们，否则每次回填都会为这批行白花向量调用。
   */
  async backfillEmbeddings(options: BackfillEmbeddingsOptions = {}): Promise<number> {
    const batchSize = options.batchSize ?? 100;
    const maxCount = options.limit ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error('batchSize 必须是正整数');
    }
    if (maxCount !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxCount) || maxCount < 1)) {
      throw new Error('limit 必须是正整数');
    }

    let completed = 0;
    while (completed < maxCount) {
      const currentBatchSize = Math.min(batchSize, maxCount - completed);
      const rows = await this.prisma.$queryRaw<Array<{ id: string; content: string }>>`
        SELECT id, content
        FROM memories
        WHERE is_active = true
          AND type NOT IN (${Prisma.join(PERSONA_STRATEGY_TYPES)})
          AND (
            embedding IS NULL
            OR embedding_model IS DISTINCT FROM ${this.embeddingService.model}
            OR embedding_dimension IS DISTINCT FROM ${this.embeddingService.dimension}
          )
        ORDER BY id
        LIMIT ${currentBatchSize}
      `;
      if (rows.length === 0) break;

      const vectors = await this.embeddingService.embedTexts(rows.map((row) => row.content));
      for (let index = 0; index < rows.length; index++) {
        await this.embedAndStore(rows[index].id, vectors[index], rows[index].content);
        completed += 1;
      }
    }

    return completed;
  }
}
