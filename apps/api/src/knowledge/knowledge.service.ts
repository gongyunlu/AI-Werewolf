import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../memory/embedding.service';
import { Prisma } from '../generated/prisma/client';
import type { AgentScenario } from '@ai-werewolf/shared';

/**
 * 攻略知识库检索服务。
 *
 * data/ 下的非结构化攻略经清洗、切块、LLM 蒸馏后落库为 knowledge_chunks 表
 * {role, scenario, trigger, action} 结构化条目，供 agent 决策链在 assembleSystemPrompt 注入口调用。
 *
 * 检索链路：query 向量化 → role/scenario 在 SQL 层硬过滤（embedding 区分不了角色，必须精确匹配）
 * → 余弦相似度取 top-k（候选 5~8，截取 4）→ 低于相关性下限则不注入（防幻觉）。
 * 检索失败必须降级为空、不能阻断对局（对齐 MemoryService.retrieveExperience 对 lesson 的处理）。
 */

/** 攻略检索候选数（先取稍多再按相似度截断，避免阈值放行数不足） */
const CANDIDATE_LIMIT = 8;
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
   * @returns 命中的攻略条目；查询/向量失败时返回空数组（降级，不阻断对局）
   */
  async retrieve(
    query: string,
    role: string | null,
    scenario: AgentScenario,
  ): Promise<KnowledgeHit[]> {
    try {
      const queryVec = await this.embeddingService.embedText(query);
      // 硬过滤：角色/场景是攻略条目的可枚举硬条件，embedding 区分不了（「我是女巫 vs 我是预言家」相似度仍高），
      // 必须在 SQL 层精确匹配，否则平民会拿到神职专属战术。'any' 表示该攻略对任意角色/场景成立。
      // role 为空（防御性，正常玩家必有角色）时不硬过滤，由相关性下限兜底。
      const roleFilter =
        role && role !== 'any' ? Prisma.sql`AND (role = ${role} OR role = 'any')` : Prisma.empty;

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
        }>
      >`
        SELECT id, role, scenario, trigger, action, content, article_title, section_title,
               1 - (embedding <=> ${JSON.stringify(queryVec)}::vector) AS similarity
        FROM knowledge_chunks
        WHERE is_active = true
          AND embedding IS NOT NULL
          AND embedding_model = ${this.embeddingService.model}
          AND embedding_dimension = ${this.embeddingService.dimension}
          AND (scenario = ${scenario} OR scenario = 'any')
          ${roleFilter}
        ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
        LIMIT ${CANDIDATE_LIMIT}
      `;

      return rows
        .filter((row) => row.similarity >= MIN_SIMILARITY)
        .slice(0, INJECT_LIMIT)
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
        }));
    } catch (error) {
      this.logger.warn(
        { role, scenario, err: error instanceof Error ? error.message : String(error) },
        '攻略知识库检索失败，已降级为空攻略',
      );
      return [];
    }
  }

  /**
   * 记录一次注入用到了哪些知识块，供事后按行为评分做质量归因。
   *
   * 属于攻略度量链路的观测数据，写失败只记日志不打断对局（对齐 MemoryService.recordUsages）。
   * rewardScore 由 judge.service.backfillRewards 回填该行为的 DecisionJudgment.score。
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
