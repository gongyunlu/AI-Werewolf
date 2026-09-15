import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../memory/embedding.service';
import { Prisma } from '../generated/prisma/client';
import type { AgentScenario } from '@ai-werewolf/shared';
import {
  knowledgeRejection,
  knowledgeSourceHash,
  type KnowledgeSituation,
} from './knowledge-policy';

/**
 * 攻略知识库检索服务。
 *
 * data/ 下的非结构化攻略经清洗、切块、LLM 蒸馏后落库为 knowledge_chunks 表
 * {role, scenario, trigger, action} 结构化条目，供 agent 决策链在 assembleSystemPrompt 注入口调用。
 *
 * 检索链路：query 向量化 → role/scenario 在 SQL 层硬过滤（embedding 区分不了角色，必须精确匹配）
 * → 板子、动作及触发条件审核 → 来源去重 → 相似度下限过滤，最多注入 4 条。
 * 检索失败必须降级为空、不能阻断对局（对齐 MemoryService.retrieveExperience 对 lesson 的处理）。
 */

/** 最终注入的攻略条数上限 */
const INJECT_LIMIT = 4;
/** 相关性下限：低于此值不注入。长文本块间余弦相似度整体低于短 trigger，初值偏松，冒烟后校准。 */
const MIN_SIMILARITY = 0.4;

/** 攻略检索结果：蒸馏条目 + 与 query 的余弦相似度 */
export interface KnowledgeHit {
  id: string;
  role: string;
  scenario: string;
  trigger: string;
  action: string;
  content: string;
  articleTitle: string;
  sectionTitle: string | null;
  similarity: number;
  version?: string;
}

export interface KnowledgeRetrievalOptions {
  situation: KnowledgeSituation;
  chunkIds?: string[];
  gameId?: string;
  playerId?: string;
  onAudit?: (id: string) => void;
  strict?: boolean;
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * 检索可注入决策链的攻略战术。
   *
   * @param query 当前局面描述（身份 + 场景 + 最近可见事件）
   * @param role 当前角色，硬过滤掉不适用攻略；null 时跳过角色过滤（防御性）
   * @param scenario 当前场景，硬过滤掉不适用攻略
   * @returns 命中的攻略条目；普通局检索失败返回空数组，实验严格模式传播异常。
   */
  async retrieve(
    query: string,
    role: string | null,
    scenario: AgentScenario,
    options?: KnowledgeRetrievalOptions,
  ): Promise<KnowledgeHit[]> {
    let hits: KnowledgeHit[] = [];
    let failure: { error: unknown } | undefined;
    let audit: Record<string, unknown> = {
      status: 'ok',
      situation: options?.situation ?? null,
      candidates: [],
    };
    try {
      const queryVec = await this.embeddingService.embedText(query);
      // 硬过滤：角色/场景是攻略条目的可枚举硬条件，embedding 区分不了（「我是女巫 vs 我是预言家」相似度仍高），
      // 必须在 SQL 层精确匹配，否则平民会拿到神职专属战术。'any' 表示该攻略对任意角色/场景成立。
      // role 为空（防御性，正常玩家必有角色）时不硬过滤，由相关性下限兜底。
      const roleFilter =
        role && role !== 'any' ? Prisma.sql`AND (role = ${role} OR role = 'any')` : Prisma.empty;
      const activeFilter = options?.chunkIds
        ? Prisma.sql`AND id IN (${Prisma.join(options.chunkIds.length ? options.chunkIds : ['00000000-0000-0000-0000-000000000000'])})`
        : Prisma.sql`AND is_active = true`;

      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          role: string;
          scenario: string;
          trigger: string;
          action: string;
          content: string;
          article_title: string;
          section_title: string | null;
          similarity: number;
          source_file: string;
          version: string;
          applicability: unknown;
        }>
      >`
        SELECT id, role, scenario, trigger, action, content, article_title, section_title, source_file, version, applicability,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS similarity
        FROM knowledge_chunks
        WHERE embedding IS NOT NULL
          ${activeFilter}
          AND embedding_model = ${this.embeddingService.model}
          AND embedding_dimension = ${this.embeddingService.dimension}
          AND (scenario = ${scenario} OR scenario = 'any')
          ${roleFilter}
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector, id
      `;

      const seen = new Set<string>();
      let selectedCount = 0;
      const candidates = rows.map((row) => {
        const sourceHash = knowledgeSourceHash({
          sourceFile: row.source_file,
          articleTitle: row.article_title,
          content: row.content,
        });
        let rejection = knowledgeRejection(row.applicability, options?.situation);
        if (!rejection && row.similarity < MIN_SIMILARITY) rejection = 'low_similarity';
        if (!rejection && seen.has(sourceHash)) rejection = 'duplicate_source';
        if (!rejection && selectedCount >= INJECT_LIMIT) rejection = 'limit';
        if (!rejection) {
          seen.add(sourceHash);
          selectedCount += 1;
        }
        return Object.assign(row, { sourceHash, rejection });
      });
      audit = { ...audit, candidates };
      hits = candidates
        .filter((row) => !row.rejection)
        .map((row) => ({
          id: row.id,
          role: row.role,
          scenario: row.scenario,
          trigger: row.trigger,
          action: row.action,
          content: row.content,
          articleTitle: row.article_title,
          sectionTitle: row.section_title,
          similarity: row.similarity,
          version: row.version,
        }));
    } catch (error) {
      this.logger.warn(
        { role, scenario, err: error instanceof Error ? error.message : String(error) },
        options?.strict ? '实验攻略检索失败，拒绝降级' : '攻略知识库检索失败，已降级为空攻略',
      );
      audit = {
        ...audit,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      failure = { error };
    }
    if (options?.gameId && options.playerId) {
      try {
        const row = await this.prisma.knowledgeRetrieval.create({
          data: {
            gameId: options.gameId,
            playerId: options.playerId,
            query,
            result: JSON.parse(JSON.stringify(audit)) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        options.onAudit?.(row.id);
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          '攻略检索日志写入失败',
        );
      }
    }
    if (options?.strict && failure) throw failure.error;
    return hits;
  }

  /**
   * 记录一次注入用到了哪些知识块，供事后按行为评分做质量归因。
   *
   * 属于攻略度量链路的观测数据，写失败只记日志不打断对局（对齐 MemoryService.recordUsages）。
   * rewardScore 列已停止回填，质量归因改从 Event 侧读取该行为的采用评分。
   */
  async recordUsages(
    rows: Array<{
      chunkId: string;
      gameId: string;
      playerId: string;
      eventId: string;
      scenario: string;
      actionType: string;
      day: number;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;

    try {
      await this.prisma.knowledgeUsage.createMany({ data: rows, skipDuplicates: true });
    } catch (error) {
      this.logger.warn(
        { count: rows.length, err: error instanceof Error ? error.message : String(error) },
        '攻略注入记录写入失败',
      );
    }
  }
}
