import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../memory/embedding.service';
import { MemoryService } from '../memory/memory.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { ConsolidationOutputSchema } from './memory-consolidate.schema';

export const MEMORY_MAINTENANCE_QUEUE = 'memory-maintenance-queue';

/** 单个 (agent, label) 的 active 记忆上限，超出后按 LRU 淘汰最冷的 lesson/reflection */
const ACTIVE_MEMORY_CAPACITY = 500;

/** 语义去重：相似度高于此阈值视为近似重复，合并并提升 confidence */
const DEDUP_SIMILARITY_THRESHOLD = 0.9;
/** 固化聚类：相似度高于此阈值视为同一主题，≥3 条提炼为 strategy */
const CONSOLIDATE_SIMILARITY_THRESHOLD = 0.7;
const CONSOLIDATE_MIN_CLUSTER = 3;

/** 重要性衰减：每 10 局 importance ×=0.9，下限 0.05 */
const DECAY_FACTOR = 0.9;
const DECAY_FLOOR = 0.05;

export const MAINTENANCE_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400 },
};

export interface MaintenanceResult {
  agents: number;
  decayed: number;
  archived: number;
  deduped: number;
  consolidated: number;
}

/** 根据已打局数判定本轮需要执行哪些维护步骤，纯函数便于测试 */
export function maintenancePlan(gameCount: number): {
  decay: boolean;
  archive: boolean;
  dedup: boolean;
  consolidate: boolean;
} {
  return {
    decay: gameCount % 10 === 0 && gameCount >= 50,
    archive: gameCount % 50 === 0 && gameCount >= 50,
    dedup: gameCount % 100 === 0 && gameCount >= 100,
    consolidate: gameCount % 100 === 0 && gameCount >= 100,
  };
}

interface ActiveLesson {
  id: string;
  title: string;
  content: string;
  importance: number;
  confidence: number;
}

/**
 * 记忆分层维护：按已打局数触发衰减 / LRU 归档 / 语义去重 / 固化。
 *
 * 四个步骤都是「软删除 + 溯源」而非物理删除，失败由 BullMQ 有界重试。
 * 独立队列 + concurrency=1：固化会用 LLM、且同一 agent 跨局可能并发触发，
 * 串行执行才能让「软删除源 + 写 strategy」的事务天然幂等，无需额外的并发 CAS。
 */
@Injectable()
export class MemoryMaintenanceService {
  private readonly logger = new Logger(MemoryMaintenanceService.name);

  constructor(
    @InjectQueue(MEMORY_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
    private readonly memoryService: MemoryService,
    private readonly promptService: PromptService,
    private readonly structuredLlm: StructuredLlmService,
  ) {}

  /** 幂等投递：同局维护任务只入队一次，重复调用直接复用已存在任务 */
  async enqueueForGame(gameId: string): Promise<void> {
    const jobId = `maintenance_${gameId}`;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if ((await existing.getState()) === 'failed') await existing.retry('failed');
      return;
    }
    await this.queue.add('run', { gameId }, { jobId, ...MAINTENANCE_JOB_OPTIONS });
  }

  async runForGame(gameId: string): Promise<MaintenanceResult> {
    const players = await this.prisma.player.findMany({
      where: { gameId },
      select: { id: true, agentId: true, memoryLabelSnapshot: true },
    });

    const groups = new Map<string, { agentId: string; label: string; playerId: string }>();
    for (const p of players) {
      const key = `${p.agentId}|${p.memoryLabelSnapshot}`;
      if (!groups.has(key)) {
        groups.set(key, { agentId: p.agentId, label: p.memoryLabelSnapshot, playerId: p.id });
      }
    }

    const result: MaintenanceResult = {
      agents: groups.size,
      decayed: 0,
      archived: 0,
      deduped: 0,
      consolidated: 0,
    };

    for (const { agentId, label, playerId } of groups.values()) {
      const gameCount = await this.countGames(agentId, label, gameId);
      const plan = maintenancePlan(gameCount);
      if (plan.decay) result.decayed += await this.decayImportance(agentId, label, gameCount);
      if (plan.archive) result.archived += await this.archiveColdMemories(agentId, label);
      if (plan.dedup) result.deduped += await this.deduplicate(agentId, label);
      if (plan.consolidate) {
        result.consolidated += await this.consolidate(agentId, label, gameId, playerId);
      }
    }

    return result;
  }

  /** 按触发局结束时间及 id 固定普通局序，排队和重试不随后续已完成对局漂移。 */
  private async countGames(agentId: string, label: string, gameId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(DISTINCT p.game_id)::int AS count
      FROM players p
      JOIN games g ON g.id = p.game_id
      JOIN games target ON target.id = ${gameId}::uuid
      WHERE p.agent_id = ${agentId}::uuid
        AND p.memory_label_snapshot = ${label}
        AND g.status = ${GAME_STATUSES.FINISHED}
        AND (g.experiment IS NULL OR g.experiment = 'null'::jsonb)
        AND target.status = ${GAME_STATUSES.FINISHED}
        AND (target.experiment IS NULL OR target.experiment = 'null'::jsonb)
        AND (g.ended_at, g.id) <= (target.ended_at, target.id)
    `;
    return rows[0]?.count ?? 0;
  }

  /**
   * 沉淀期衰减：lesson 的 importance ×=0.9，用 metadata 标记本局序防止同一局重复衰减。
   * jsonb_set 的 create_missing 只创建路径最后一个键、不创建中间父级，故先补齐 maintenance 空对象。
   */
  private async decayImportance(
    agentId: string,
    label: string,
    gameCount: number,
  ): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE memories
      SET importance = GREATEST(${DECAY_FLOOR}, importance * ${DECAY_FACTOR}),
          metadata = jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{maintenance}',
              COALESCE(metadata->'maintenance', '{}'::jsonb),
              true
            ),
            '{maintenance,lastDecayedGameCount}',
            to_jsonb(${gameCount}::int),
            true
          ),
          updated_at = NOW()
      WHERE agent_id = ${agentId}::uuid
        AND label = ${label}
        AND is_active = true
        AND type = 'lesson'
        AND COALESCE((metadata->'maintenance'->>'lastDecayedGameCount')::int, 0) < ${gameCount}
    `;
  }

  /** 归档期：按 LRU 容量驱逐最冷的 lesson/reflection，只碰可归档类型 */
  private async archiveColdMemories(agentId: string, label: string): Promise<number> {
    const [{ total }] = await this.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
      FROM memories
      WHERE agent_id = ${agentId}::uuid AND label = ${label} AND is_active = true
    `;
    if (total <= ACTIVE_MEMORY_CAPACITY) return 0;

    const evictCount = total - ACTIVE_MEMORY_CAPACITY;
    // 最后使用时间 = 该记忆所有 usage 局里 ended_at 最晚者，无 usage 的 reflection 取创建局时间
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT m.id
      FROM memories m
      LEFT JOIN games og ON og.id = m.game_id
      LEFT JOIN memory_usages u ON u.memory_id = m.id
      LEFT JOIN games ug ON ug.id = u.game_id
      WHERE m.agent_id = ${agentId}::uuid
        AND m.label = ${label}
        AND m.is_active = true
        AND m.type IN ('lesson', 'reflection')
      GROUP BY m.id, og.ended_at
      ORDER BY COALESCE(MAX(ug.ended_at), og.ended_at) ASC
      LIMIT ${evictCount}
    `;
    if (rows.length === 0) return 0;

    const { count } = await this.prisma.memory.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, isActive: true },
      data: { isActive: false },
    });
    return count;
  }

  /** 语义去重：相似度 >0.9 的 lesson 对，按 confidence 降序贪心保留一条，其余软删除并入 */
  private async deduplicate(agentId: string, label: string): Promise<number> {
    const pairs = await this.findSimilarPairs(agentId, label, DEDUP_SIMILARITY_THRESHOLD);
    if (pairs.length === 0) return 0;

    const lessons = await this.loadLessons(agentId, label);
    const adjacency = new Map<string, Set<string>>();
    for (const { idA, idB } of pairs) {
      if (!adjacency.has(idA)) adjacency.set(idA, new Set());
      if (!adjacency.has(idB)) adjacency.set(idB, new Set());
      adjacency.get(idA)!.add(idB);
      adjacency.get(idB)!.add(idA);
    }

    // loadLessons 已按 confidence 降序返回：高置信者先成为 keeper，低置信邻接者被并入
    const dropped = new Set<string>();
    let deduped = 0;
    for (const keeper of lessons) {
      if (dropped.has(keeper.id)) continue;
      const neighbors = adjacency.get(keeper.id);
      if (!neighbors) continue;

      const merged = [...neighbors].filter((id) => id !== keeper.id && !dropped.has(id));
      if (merged.length === 0) continue;
      merged.forEach((id) => dropped.add(id));

      await this.prisma.$transaction(async (tx) => {
        await tx.memory.updateMany({
          where: { id: { in: merged }, isActive: true },
          data: { isActive: false },
        });
        await tx.memoryDerivation.createMany({
          data: merged.map((sourceMemoryId) => ({
            derivedMemoryId: keeper.id,
            sourceMemoryId,
          })),
          skipDuplicates: true,
        });
        await tx.memory.update({
          where: { id: keeper.id },
          data: { confidence: Math.min(1, keeper.confidence + 0.1 * merged.length) },
        });
      });
      deduped += merged.length;
    }
    return deduped;
  }

  /** 固化：无角色、场景和事实条件限制的 lesson 聚类（≥3 条、相似度 >0.7）后提炼为 strategy */
  private async consolidate(
    agentId: string,
    label: string,
    gameId: string,
    playerId: string,
  ): Promise<number> {
    const lessons = await this.loadLessons(agentId, label, 'any');
    if (lessons.length < CONSOLIDATE_MIN_CLUSTER) return 0;

    const pairs = await this.findSimilarPairs(
      agentId,
      label,
      CONSOLIDATE_SIMILARITY_THRESHOLD,
      'any',
    );
    if (pairs.length === 0) return 0;

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const p = parent.get(x);
      if (p === undefined || p === x) {
        parent.set(x, x);
        return x;
      }
      const root = find(p);
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    lessons.forEach((l) => parent.set(l.id, l.id));
    pairs.forEach(({ idA, idB }) => union(idA, idB));

    const clusters = new Map<string, ActiveLesson[]>();
    for (const lesson of lessons) {
      const root = find(lesson.id);
      const members = clusters.get(root) ?? [];
      members.push(lesson);
      clusters.set(root, members);
    }

    let consolidated = 0;
    for (const members of clusters.values()) {
      if (members.length < CONSOLIDATE_MIN_CLUSTER) continue;

      const lessonText = members.map((m) => `### ${m.title}\n${m.content}`).join('\n\n');
      const [systemPrompt, userPrompt] = await Promise.all([
        this.promptService.render(PROMPT_NAMES.memoryConsolidationSystem),
        this.promptService.render(PROMPT_NAMES.memoryConsolidationUser, { lessons: lessonText }),
      ]);
      const { output } = await this.structuredLlm.invoke({
        schema: ConsolidationOutputSchema,
        runName: 'memory-consolidation',
        scenario: 'consolidation',
        system: systemPrompt.text,
        user: userPrompt.text,
        gameId,
        playerId,
        promptName: userPrompt.name,
        promptVersion: userPrompt.version,
        promptSource: userPrompt.source,
        promptOrigin: userPrompt.origin,
      });

      const importance = Math.max(...members.map((m) => m.importance));
      const created = await this.persistStrategy(agentId, label, members, output, importance);
      if (created) consolidated += 1;
    }
    return consolidated;
  }

  /** 事务内创建 strategy + 软删除源 lesson + 写溯源；向量在事务外补写（失败可回填） */
  private async persistStrategy(
    agentId: string,
    label: string,
    members: ActiveLesson[],
    output: { title: string; content: string },
    importance: number,
  ): Promise<{ id: string; content: string } | null> {
    const sourceIds = members.map((m) => m.id);
    const created = await this.prisma.$transaction(async (tx) => {
      const strategy = await tx.memory.create({
        data: {
          agentId,
          label,
          gameId: null,
          type: 'strategy',
          title: output.title,
          content: output.content,
          importance,
          confidence: 0.8,
          source: 'refined',
          metadata: { consolidated: true, sourceCount: members.length },
        },
        select: { id: true, content: true },
      });
      await tx.memory.updateMany({
        where: { id: { in: sourceIds }, isActive: true },
        data: { isActive: false },
      });
      await tx.memoryDerivation.createMany({
        data: sourceIds.map((sourceMemoryId) => ({
          derivedMemoryId: strategy.id,
          sourceMemoryId,
        })),
        skipDuplicates: true,
      });
      return strategy;
    });

    await this.memoryService.embedMemories([created]);
    return created;
  }

  /** 自连接找出相似度超过阈值的 lesson 对（去重 + 固化的共同底座） */
  private async findSimilarPairs(
    agentId: string,
    label: string,
    threshold: number,
    roleFilter?: string,
  ): Promise<Array<{ idA: string; idB: string }>> {
    const roleSql = roleFilter
      ? Prisma.sql`AND a.metadata->>'role' = ${roleFilter} AND b.metadata->>'role' = ${roleFilter}
          AND a.metadata->>'scenario' = 'any' AND b.metadata->>'scenario' = 'any'
          AND a.metadata->'conditions' = '[]'::jsonb AND b.metadata->'conditions' = '[]'::jsonb`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ id_a: string; id_b: string }>>`
      SELECT a.id AS id_a, b.id AS id_b
      FROM memories a
      JOIN memories b ON a.id < b.id
      WHERE a.agent_id = ${agentId}::uuid AND a.label = ${label}
        AND a.is_active = true AND a.type = 'lesson'
        AND a.embedding IS NOT NULL
        AND a.embedding_model = ${this.embeddingService.model}
        AND a.embedding_dimension = ${this.embeddingService.dimension}
        AND b.agent_id = ${agentId}::uuid AND b.label = ${label}
        AND b.is_active = true AND b.type = 'lesson'
        AND b.embedding IS NOT NULL
        AND b.embedding_model = ${this.embeddingService.model}
        AND b.embedding_dimension = ${this.embeddingService.dimension}
        AND a.metadata->>'role' = b.metadata->>'role'
        AND a.metadata->>'scenario' = b.metadata->>'scenario'
        AND a.metadata->'conditions' IS NOT DISTINCT FROM b.metadata->'conditions'
        ${roleSql}
        AND 1 - (a.embedding <=> b.embedding) > ${threshold}
    `;
    return rows.map((r) => ({ idA: r.id_a, idB: r.id_b }));
  }

  /** 加载 active 且已向量的 lesson，按 confidence 降序返回（去重贪心的处理顺序） */
  private async loadLessons(
    agentId: string,
    label: string,
    roleFilter?: string,
  ): Promise<ActiveLesson[]> {
    const roleSql = roleFilter
      ? Prisma.sql`AND metadata->>'role' = ${roleFilter}
          AND metadata->>'scenario' = 'any' AND metadata->'conditions' = '[]'::jsonb`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; content: string; importance: number; confidence: number }>
    >`
      SELECT id, title, content, importance, confidence
      FROM memories
      WHERE agent_id = ${agentId}::uuid
        AND label = ${label}
        AND is_active = true
        AND type = 'lesson'
        AND embedding IS NOT NULL
        AND embedding_model = ${this.embeddingService.model}
        AND embedding_dimension = ${this.embeddingService.dimension}
        ${roleSql}
      ORDER BY confidence DESC, created_at ASC, id ASC
    `;
    return rows;
  }
}
