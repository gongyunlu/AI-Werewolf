import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { hashMemoryContent } from './memory.service';
import type { Prisma } from '../generated/prisma/client';

/** 聚类归簇的余弦相似度阈值：同一认知达此相似度视为同一 pattern */
const PATTERN_PROMOTE_SIMILARITY = 0.85;
/** 晋升门槛：同一认知在多少场不同对局出现 */
const PATTERN_PROMOTE_MIN_GAMES = 3;

/** 对局级复盘产出的 pattern 候选（结构同 GameReviewOutputSchema.patterns） */
export interface PatternCandidateInput {
  title: string;
  content: string;
  importance: number;
}

/** 已晋升的全局 pattern，注入 system prompt 使用 */
export interface ActivePattern {
  title: string;
  content: string;
}

/**
 * 全局共享记忆：pattern 的跨对局语义聚类与晋升。
 *
 * 对局级复盘产出的 pattern 是单局样本，可能是偶然。同一认知在 ≥3 场不同对局
 * 出现（embedding 余弦 ≥ 阈值）后才晋升为 global_memories（source='aggregated'），
 * 避免单局偶然认知污染所有 Agent 及未来接入的模型。
 */
@Injectable()
export class GlobalMemoryService {
  private readonly logger = new Logger(GlobalMemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * pattern 聚类与晋升。幂等：同一对局的 pattern 只处理一次。
   *
   * 逐条 pattern 与候选（含已晋升）比对余弦相似度，达阈值归簇（累加来源对局），
   * 否则新建候选；来源对局去重后达门槛即晋升。簇代表取最早出现的候选内容。
   */
  async promotePatterns(gameId: string, patterns: PatternCandidateInput[]): Promise<number> {
    if (patterns.length === 0) return 0;

    if (await this.hasProcessedGame(this.prisma, gameId)) return 0;

    const vectors = await this.embeddingService.embedTexts(patterns.map((p) => p.content));

    // 模型调用在事务外；锁内重新检查幂等，整局候选、向量与晋升一起提交或回滚。
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('pattern-promotion', 0))`;
      if (await this.hasProcessedGame(tx, gameId)) return 0;
      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i]!;
        const vector = vectors[i]!;

        const similar = await tx.$queryRaw<Array<{ id: string; similarity: number }>>`
        SELECT id, 1 - (embedding <=> ${JSON.stringify(vector)}::vector) AS similarity
        FROM pattern_candidates
        WHERE embedding IS NOT NULL
          AND embedding_model = ${this.embeddingService.model}
          AND embedding_dimension = ${this.embeddingService.dimension}
        ORDER BY embedding <=> ${JSON.stringify(vector)}::vector, created_at, id
        LIMIT 1
      `;

        if (similar.length > 0 && similar[0]!.similarity >= PATTERN_PROMOTE_SIMILARITY) {
          // 归簇：来源对局去重后写回，不新增候选行
          const candidate = await tx.patternCandidate.findUniqueOrThrow({
            where: { id: similar[0]!.id },
            select: { sourceGameIds: true },
          });
          const gameIds = new Set(candidate.sourceGameIds as string[]);
          gameIds.add(gameId);
          await tx.patternCandidate.update({
            where: { id: similar[0]!.id },
            data: { sourceGameIds: [...gameIds] },
          });
        } else {
          // 新簇：写入候选正文，再补 embedding（create 无法写 Unsupported 向量列）
          const created = await tx.patternCandidate.create({
            data: {
              gameId,
              title: pattern.title,
              content: pattern.content,
              importance: pattern.importance,
              sourceGameIds: [gameId],
            },
          });
          await tx.$executeRaw`
          UPDATE pattern_candidates
          SET embedding = ${JSON.stringify(vector)}::vector,
              embedding_model = ${this.embeddingService.model},
              embedding_dimension = ${this.embeddingService.dimension},
              embedding_content_hash = ${hashMemoryContent(pattern.content)},
              embedded_at = NOW()
          WHERE id = ${created.id}::uuid
        `;
        }
      }

      return this.promoteReadyCandidates(tx);
    });
  }

  private async hasProcessedGame(tx: Prisma.TransactionClient, gameId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pattern_candidates
      WHERE game_id = ${gameId}::uuid OR source_game_ids @> ${JSON.stringify([gameId])}::jsonb
    `;
    return (rows[0]?.count ?? 0) > 0;
  }

  /** 晋升检查：来源对局数达门槛的候选写 global_memories 并标记晋升 */
  private async promoteReadyCandidates(tx: Prisma.TransactionClient): Promise<number> {
    const ready = await tx.$queryRaw<
      Array<{
        id: string;
        title: string;
        content: string;
        importance: number;
        source_game_ids: string[];
      }>
    >`
      SELECT id, title, content, importance, source_game_ids
      FROM pattern_candidates
      WHERE promoted_at IS NULL AND jsonb_array_length(source_game_ids) >= ${PATTERN_PROMOTE_MIN_GAMES}
    `;

    for (const candidate of ready) {
      await tx.globalMemory.create({
        data: {
          type: 'pattern',
          source: 'aggregated',
          title: candidate.title,
          content: candidate.content,
          importance: candidate.importance,
          sourceGameIds: candidate.source_game_ids,
          isActive: true,
        },
      });
      await tx.patternCandidate.update({
        where: { id: candidate.id },
        data: { promotedAt: new Date() },
      });
    }

    if (ready.length > 0) {
      this.logger.log(
        { gameIds: ready.map((c) => c.source_game_ids), count: ready.length },
        'pattern 晋升为全局记忆',
      );
    }
    return ready.length;
  }

  /** 检索已晋升的全局 pattern（全量，晋升门槛已控量，不做 topK） */
  async retrieveActivePatterns(): Promise<ActivePattern[]> {
    return this.prisma.globalMemory.findMany({
      where: { type: 'pattern', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { title: true, content: true },
    });
  }
}
