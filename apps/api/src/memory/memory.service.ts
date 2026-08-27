import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { MemoryType } from '@ai-werewolf/shared';
import { Prisma } from '../generated/prisma/client';
import { EmbeddingService } from './embedding.service';

export type ActiveMemory = Prisma.MemoryGetPayload<{
  select: {
    id: true;
    type: true;
    title: true;
    content: true;
    importance: true;
  };
}>;

export type RetrieveActiveMemoriesOptions = {
  types?: MemoryType[]; // 指定类型集合，缺省不过滤
  limit?: number; // 每次取多少条，默认 20
};

export type BackfillEmbeddingsOptions = {
  /** 每次从数据库领取的最大记录数；EmbeddingService 内部仍按供应商上限拆批。 */
  batchSize?: number;
  /** 本次命令最多处理多少条，缺省处理完全部 active Memory。 */
  limit?: number;
};

function hashMemoryContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

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
    if (rows.length > 0) {
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

  /**
   * 语义检索：基于 query 的 embedding 与记忆 embedding 的余弦距离排序。
   * 当前仅作为能力提供，未被 agent-runtime 调用（留待数据积累后切换）。
   */
  async retrieveBySimilarity(
    agentId: string,
    label: string,
    query: string,
    limit = 20,
  ): Promise<ActiveMemory[]> {
    const queryVec = await this.embeddingService.embedText(query);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; title: string; content: string; importance: number }>
    >`
      SELECT id, type, title, content, importance
      FROM memories
      WHERE agent_id = ${agentId}::uuid
        AND label = ${label}
        AND is_active = true
        AND embedding IS NOT NULL
        AND embedding_model = ${this.embeddingService.model}
        AND embedding_dimension = ${this.embeddingService.dimension}
      ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
      LIMIT ${limit}
    `;

    if (rows.length > 0) {
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

  /** 分批回填 active Memory；每条成功后立即落库，失败后可安全重跑。 */
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
