import { Logger } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { resolveModelCapability } from '../llm/model-capability';
import { RoleSchema } from '@ai-werewolf/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { knowledgeSourceHash, knowledgeEmbeddingText } from './knowledge-policy';
import { storeKnowledgeChunk, writeKnowledgeEmbedding } from './knowledge-build-store';

const repositoryRoot = resolve(__dirname, '../../../..');

// .env.local 优先于 .env（dotenv 默认不覆盖已存在的 process.env 变量）
loadEnv({ path: resolve(repositoryRoot, '.env.local') });
loadEnv({ path: resolve(repositoryRoot, '.env') });

/** 本管线处理的三个已清洗攻略文件（相对 data/cleaned/ 的文件名，作 source_file 审计用） */
const SOURCE_FILES = ['juese-clean.md', 'mengxin-clean.md', 'jiaoxue-clean.md'] as const;

/** 蒸馏输出：role 用 shared ROLES 枚举或 'any'，scenario 用 AGENT_SCENARIOS 5 值或 'any' */
const ScenarioSchema = z.enum([
  'vote',
  'day_speech',
  'night_action',
  'last_words',
  'sheriff_decide_order',
  'any',
]);
const DistillChunkSchema = z.object({
  role: RoleSchema.or(z.literal('any')),
  scenario: ScenarioSchema,
  trigger: z.string(),
  action: z.string(),
});
type DistillChunk = z.infer<typeof DistillChunkSchema>;

/** 切块后的原始块（含输入与定位信息，待蒸馏） */
type RawChunk = {
  sourceFile: string;
  articleTitle: string;
  sectionTitle: string | null;
  content: string;
};

/** 一条已蒸馏、待落库的结果 */
type BuiltChunk = RawChunk & { distilled: DistillChunk };

/** 语料内的一个 `### ` 小节（无 `### ` 的文章整体视为一个 title 为空的 section） */
type Section = { title: string | null; content: string };

const MAX_CHUNK = 500; // 合并块目标上限：相邻小节合并到该长度
const MIN_CHUNK = 300; // 目标下限（作为合并是否充分的参考，不作为硬切分点）

/** 超长单小节阈值：达到该长度即按段落拆成多个 300~500 字块，不硬截断尾内容 */
const OVER_MAX = 500;

const EMBEDDING_DIMENSION = 2048; // doubao-embedding-vision 输出 2048 维，写库前校验
const EMBEDDING_BATCH_SIZE = 10; // 火山方舟 embedding API 单次请求上限 10 条

const EMBEDDING_PROMPT = [
  '你是狼人杀攻略蒸馏器。把一段攻略正文提炼成一条结构化战术条目，供 agent 对局决策时按局面检索注入。',
  '- role：这段正文主要适用于哪个角色，用英文枚举（villager/seer/witch/hunter/guard/idiot/dreamweaver/thief/cupid/werewolf/wolf_king/white_wolf/wolf_beauty/demon 等）；对任何身份都成立或讲的是通用能力（抿人、表水、位置学、术语，不专属某角色）填 `any`。**不把 `any` 当默认值**，正文明确讲某角色玩法就必须填该角色。',
  '- scenario：这段正文主要适用于哪个场景（vote=投票/day_speech=白天发言/night_action=夜间行动/last_words=遗言/sheriff_decide_order=警长定序）；跨场景或讲的是角色整个对局定位才填 `any`。',
  '- trigger：用一两句话描述「什么局面下该参考这条战术」，必须是可复现的局面条件（如「我是预言家，警上前置位有悍跳狼时」），不要写「我是预言家」这种没有局面条件的大类描述，也不要包含座位号/具体玩家。',
  '- action：该局面下具体怎么做（2~4 句，含该角色视角的战术动作），不是重复 trigger。',
].join('\n');

const logger = new Logger('KnowledgeBuild');

/** 清洗：去掉行首全角/ASCII 空格、剔空行、收尾去空白，保留正文标点与 `### ` 标题行 */
function cleanText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^[　 \t]+/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const cleanCache = new Map<string, string>();
function cleanTextCached(text: string): string {
  const cached = cleanCache.get(text);
  if (cached !== undefined) return cached;
  const cleaned = cleanText(text);
  cleanCache.set(text, cleaned);
  return cleaned;
}

/** 把一篇 `## 标题` 文章切成 (article_title, sections)；无 `### ` 时整体成为一个无 title section */
function parseArticle(body: string): { title: string; sections: Section[] } {
  const lines = body.split('\n');
  const titleLine = lines.find((line) => line.startsWith('## '));
  const title = (titleLine ?? '').replace(/^##\s*/, '').trim();

  // 只剔掉文章标题行本身，保留 `### ` 小节标题作章节锚点
  // （不能按 startsWith('## ') 过滤：那会连同 `### ` 小节标题一起滤掉）
  const sectionLines = lines.filter((line) => line !== titleLine);

  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of sectionLines) {
    const cleaned = cleanTextCached(line);
    if (cleaned.length === 0) continue;
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), content: '' };
    } else {
      const text = cleanTextCached(line);
      if (current) current.content += (current.content ? '\n' : '') + text;
      else current = { title: null, content: text };
    }
  }
  if (current) sections.push(current);

  // 把文章开头的无 `### ` 前言并入紧随的首个小节，避免前言被挤出成无锚孤块。
  // 通篇无 `### ` 的文章（术语/位置玄学/表水等）仍是单一 title=null section，不进此分支。
  if (sections.length >= 2 && sections[0].title === null) {
    const intro = sections[0].content;
    if (intro.length > 0) {
      sections[1].content = intro + (sections[1].content ? '\n' : '') + sections[1].content;
    }
    sections.shift();
  }

  return { title, sections: sections.map((s) => ({ title: s.title, content: s.content.trim() })) };
}

/**
 * 切块：以 `### ` 小节为基本单元，相邻小节贪心合并到 300~500 字。
 * - 单小节 >= OVER_MAX 独立成块，不硬拆（内容有边界，避免拦腰斩断）。
 * - 合并目标：尽量让每块落在 [MIN_CHUNK, MAX_CHUNK]，只在合并会超过 MAX_CHUNK 时落地当前 buffer。
 * - 无 `### ` 的 section（title=null，如新手术语/位置玄学整篇）同样参与合并，section_title 置空。
 */
function chunkSections(sourceFile: string, articleTitle: string, sections: Section[]): RawChunk[] {
  const out: RawChunk[] = [];
  let buffer = '';
  let bufferTitle: string | null = null;

  const flush = () => {
    const content = buffer.trim();
    if (content.length === 0) return;
    out.push({ sourceFile, articleTitle, sectionTitle: bufferTitle, content });
    buffer = '';
    bufferTitle = null;
  };

  for (const section of sections) {
    const content = section.content.trim();
    if (content.length === 0) continue;

    // 单小节本身就是超长块（>= OVER_MAX）：按段落拆成多块，避免截断丢内容
    if (section.content.length >= OVER_MAX) {
      if (buffer) flush();
      for (const part of splitLongSection(section.content)) {
        out.push({ sourceFile, articleTitle, sectionTitle: section.title, content: part });
      }
      continue;
    }

    // 合并会超上限：先落地当前 buffer，再用该小节开新块
    if (buffer && buffer.length + content.length > MAX_CHUNK) {
      flush();
      buffer = content;
      bufferTitle = section.title;
      continue;
    }

    buffer += (buffer ? '\n' : '') + content;
    if (!bufferTitle) bufferTitle = section.title;
  }

  flush();
  return out;
}

/**
 * 把超长单小节按段落拆成 300~500 字的连续块（不丢失尾部内容）。
 * 优先按空行分组，无空行分组时退化为按 `\n` 行累积；两个边界都无则按字硬拆。
 */
function splitLongSection(content: string): string[] {
  const byBlankLine = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const parts =
    byBlankLine.length > 1
      ? byBlankLine
      : content
          .split('\n')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
  const units = parts.length > 1 ? parts : (content.match(/[\s\S]{1,200}/g) ?? []);
  const out: string[] = [];
  let buffer = '';
  for (const unit of units) {
    const next = (buffer ? buffer + '\n' : '') + unit;
    if (buffer && next.length > MAX_CHUNK) {
      // 当前 buffer 已到上限：若它偏小（如上一个超长段的尾部残余），并入前一块避免碎块，
      // 否则作为独立块落地。
      if (buffer.trim().length < MIN_CHUNK && out.length > 0) {
        out[out.length - 1] += (out[out.length - 1] ? '\n' : '') + buffer;
      } else {
        out.push(buffer);
      }
      buffer = unit;
    } else {
      buffer = next;
    }
  }
  if (buffer.trim().length > 0) {
    // 末尾不足 MIN_CHUNK 的残余并入最后一块，避免丢尾巴又产生碎块
    if (out.length > 0 && buffer.trim().length < MIN_CHUNK) {
      out[out.length - 1] += '\n' + buffer;
    } else {
      out.push(buffer);
    }
  }
  return out;
}

/** sha256 内容哈希，对齐 MemoryService.hashMemoryContent */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 校验 2048 维向量，对齐 EmbeddingService.assertValidVector（本脚本不依赖 Nest 注入） */
function assertValidVector(vector: unknown): asserts vector is number[] {
  if (!Array.isArray(vector)) {
    throw new Error('Embedding 向量格式无效：期望数字数组');
  }
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding 向量维度无效：期望 ${EMBEDDING_DIMENSION} 维，实际 ${vector.length} 维`,
    );
  }
  const invalidIndex = vector.findIndex(
    (value) => typeof value !== 'number' || !Number.isFinite(value),
  );
  if (invalidIndex !== -1) {
    throw new Error(`Embedding 向量数值无效：索引 ${invalidIndex} 不是有限数值`);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ARK_API_KEY;
  const modelName = process.env.ARK_DEFAULT_MODEL;
  const baseUrl = process.env.ARK_BASE_URL;
  const embeddingModel = process.env.ARK_EMBEDDING_MODEL ?? 'doubao-embedding-vision';
  if (!databaseUrl || !apiKey || !modelName || !baseUrl) {
    throw new Error('缺少必要环境变量（DATABASE_URL/ARK_API_KEY/ARK_DEFAULT_MODEL/ARK_BASE_URL）');
  }

  if (process.argv.includes('--reset'))
    throw new Error('不再支持删除历史攻略；请使用 --version=<新版本> 重建并保留使用记录');
  const version =
    process.argv.find((arg) => arg.startsWith('--version='))?.slice('--version='.length) ??
    'distilled-v2';
  const probe = process.argv.includes('--probe');
  // --limit=N：只蒸馏前 N 块（冒烟用，验证 ARK 通路；<0 表示不限）
  const limitOpt = process.argv.find((arg) => arg.startsWith('--limit='));
  const chunkLimit = limitOpt ? Number(limitOpt.slice('--limit='.length)) : -1;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  await prisma.$connect();

  try {
    // 1. 读语料 → 切块
    const rawChunks: RawChunk[] = [];
    for (const sourceFile of SOURCE_FILES) {
      const raw = readFileSync(resolve(repositoryRoot, 'data/cleaned', sourceFile), 'utf8');
      const articles = raw.split(/^---\s*$/m).filter((article) => article.trim().length > 0);
      for (const article of articles) {
        const { title, sections } = parseArticle(article);
        if (sections.length === 0) continue;
        for (const chunk of chunkSections(sourceFile, title || sourceFile, sections)) {
          rawChunks.push(chunk);
        }
      }
    }

    if (probe) {
      const withTitle = rawChunks.filter((c) => c.sectionTitle).length;
      logger.log(
        `[probe] 共 ${rawChunks.length} 块；含小节锚点 ${withTitle} 块；无锚点 ${rawChunks.length - withTitle} 块`,
      );
      logger.log(
        `[probe] 长度分布：min=${Math.min(...rawChunks.map((c) => c.content.length))} max=${Math.max(...rawChunks.map((c) => c.content.length))}`,
      );
      const under300 = rawChunks.filter((c) => c.content.length < 300);
      logger.log(`[probe] <300 字块：${under300.length} 个`);
      for (const c of under300) {
        logger.log(
          `  - <300: ${c.sourceFile} | ${c.articleTitle} | 小节=${c.sectionTitle ?? '（无）'} | ${c.content.length}字`,
        );
      }
      const noAnchor = rawChunks.filter((c) => !c.sectionTitle);
      logger.log(`[probe] 无锚点块：`);
      for (const c of noAnchor) {
        logger.log(`  - 无锚: ${c.sourceFile} | ${c.articleTitle} | ${c.content.length}字`);
      }
      const sample = rawChunks.find((c) => c.sectionTitle !== null);
      if (sample) {
        logger.log(
          `[probe] 样例：${sample.sourceFile} / ${sample.articleTitle} / 小节「${sample.sectionTitle}」${sample.content.length}字\n${sample.content.slice(0, 120)}`,
        );
      }
      return;
    }

    logger.log(`切块完成：共 ${rawChunks.length} 块`);

    // 2. 蒸馏：每块一次结构化输出调用，失败计数不中断
    const existing = await prisma.knowledgeChunk.findMany({
      where: { version },
      select: { sourceHash: true },
    });
    const knownHashes = new Set(existing.map((row) => row.sourceHash));
    const uniqueChunks = [
      ...new Map(rawChunks.map((chunk) => [knowledgeSourceHash(chunk), chunk])).values(),
    ];
    const pending = uniqueChunks.filter((chunk) => !knownHashes.has(knowledgeSourceHash(chunk)));
    const toDistill = chunkLimit >= 0 ? pending.slice(0, chunkLimit) : pending;
    if (chunkLimit >= 0)
      logger.log(
        `--limit=${chunkLimit}：仅蒸馏前 ${Math.min(chunkLimit, rawChunks.length)} 块（冒烟）`,
      );
    const distillModel = new ChatOpenAI({
      apiKey,
      model: modelName,
      configuration: { baseURL: baseUrl },
      streaming: false,
      timeout: 300_000,
      maxRetries: 0,
    }).withStructuredOutput(z.toJSONSchema(DistillChunkSchema), {
      method: resolveModelCapability(modelName).protocol,
    });

    let distillSuccess = 0;
    let distillFailed = 0;
    const successful: BuiltChunk[] = [];
    for (let i = 0; i < toDistill.length; i++) {
      const chunk = toDistill[i];
      try {
        const raw = await distillModel.invoke([
          new SystemMessage(EMBEDDING_PROMPT),
          new HumanMessage(
            `来源：${chunk.sourceFile} / ${chunk.articleTitle}\n${chunk.sectionTitle ? `小节：${chunk.sectionTitle}\n` : ''}正文：\n${chunk.content}`,
          ),
        ]);
        const distilled = DistillChunkSchema.parse(raw);
        successful.push({ ...chunk, distilled });
        distillSuccess += 1;
      } catch (error) {
        distillFailed += 1;
        logger.warn(
          `蒸馏失败 第 ${i + 1}/${toDistill.length} 块：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    logger.log(`蒸馏完成：成功 ${distillSuccess}，失败 ${distillFailed}`);

    // 3. 落库：逐块 INSERT（id 由模型默认 uuid() 生成，embedding 列先留空）
    const inserted: Array<{ id: string; content: string }> = [];
    let insertFailed = 0;
    for (const chunk of successful) {
      try {
        const sourceHash = knowledgeSourceHash(chunk);
        const row = await storeKnowledgeChunk(prisma, {
          version,
          sourceHash,
          sourceFile: chunk.sourceFile,
          articleTitle: chunk.articleTitle,
          sectionTitle: chunk.sectionTitle,
          role: chunk.distilled.role,
          scenario: chunk.distilled.scenario,
          trigger: chunk.distilled.trigger,
          action: chunk.distilled.action,
          content: chunk.content,
          isActive: false, // 未经适用性审核的蒸馏结果不直接进入对局
        });
        inserted.push(row);
      } catch (error) {
        insertFailed += 1;
        logger.warn(
          `落库失败 ${chunk.sourceFile}/${chunk.articleTitle}：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    logger.log(`落库完成：成功 ${inserted.length}，失败 ${insertFailed}`);
    const pendingEmbeddings = await prisma.$queryRaw<
      Array<{
        id: string;
        role: string;
        scenario: string;
        trigger: string;
        action: string;
        embedding_content_hash: string | null;
        embedding_model: string | null;
        has_embedding: boolean;
      }>
    >`
      SELECT id, role, scenario, trigger, action, embedding_content_hash, embedding_model, embedding IS NOT NULL AS has_embedding FROM knowledge_chunks
      WHERE version = ${version}
    `;
    for (const chunk of pendingEmbeddings) {
      if (
        !inserted.some((row) => row.id === chunk.id) &&
        (!chunk.has_embedding ||
          chunk.embedding_model !== embeddingModel ||
          chunk.embedding_content_hash !== hashContent(knowledgeEmbeddingText(chunk)))
      )
        inserted.push({ id: chunk.id, content: knowledgeEmbeddingText(chunk) });
    }

    // 4. embedding：按 10 条分批 embedDocuments，校验维度后逐块 UPDATE
    const embeddings = new OpenAIEmbeddings({
      apiKey,
      model: embeddingModel,
      configuration: { baseURL: baseUrl },
    });

    let embedded = 0;
    for (let i = 0; i < inserted.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = inserted.slice(i, i + EMBEDDING_BATCH_SIZE);
      try {
        const vectors = await embeddings.embedDocuments(batch.map((row) => row.content));
        if (vectors.length !== batch.length) {
          throw new Error(
            `Embedding 服务返回数量异常：期望 ${batch.length} 条，实际 ${vectors.length} 条`,
          );
        }
        for (let j = 0; j < batch.length; j++) {
          const vector = vectors[j];
          assertValidVector(vector);
          await writeKnowledgeEmbedding(prisma, batch[j], vector, embeddingModel);
          embedded += 1;
        }
      } catch (error) {
        logger.warn(
          `embedding 批次失败 第 ${i + 1}-${Math.min(i + EMBEDDING_BATCH_SIZE, inserted.length)} 块：${
            error instanceof Error ? error.message : String(error)
          }（未完成条目可重跑补齐）`,
        );
      }
    }
    logger.log(`embedding 完成：成功写入 ${embedded} 块`);

    // 5. 盘点
    const total = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM knowledge_chunks
    `;
    const roleDist = await prisma.$queryRaw<Array<{ role: string; count: bigint }>>`
      SELECT role, count(*) AS count FROM knowledge_chunks GROUP BY role ORDER BY role
    `;
    const scenarioDist = await prisma.$queryRaw<Array<{ scenario: string; count: bigint }>>`
      SELECT scenario, count(*) AS count FROM knowledge_chunks GROUP BY scenario ORDER BY scenario
    `;
    logger.log(`knowledge_chunks 总块数：${total[0]?.count?.toString() ?? 0}`);
    logger.log('role 分布：' + roleDist.map((r) => `${r.role}=${r.count}`).join(', '));
    logger.log('scenario 分布：' + scenarioDist.map((s) => `${s.scenario}=${s.count}`).join(', '));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
