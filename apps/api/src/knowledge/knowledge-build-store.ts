import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { knowledgeEmbeddingText } from './knowledge-policy';

export interface KnowledgeEmbeddingTask {
  id: string;
  content: string;
}

/** 冲突时沿用已落库的蒸馏正文，向量输入必须来自 upsert 返回的赢家。 */
export async function storeKnowledgeChunk(
  prisma: Pick<PrismaClient, 'knowledgeChunk'>,
  data: Prisma.KnowledgeChunkCreateInput & { version: string; sourceHash: string },
): Promise<KnowledgeEmbeddingTask> {
  const row = await prisma.knowledgeChunk.upsert({
    where: { version_sourceHash: { version: data.version, sourceHash: data.sourceHash } },
    update: {},
    create: data,
    select: { id: true, role: true, scenario: true, trigger: true, action: true },
  });
  return { id: row.id, content: knowledgeEmbeddingText(row) };
}

/** embedding 计算期间正文如有变化，拒绝把旧向量写入新正文。 */
export async function writeKnowledgeEmbedding(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  task: KnowledgeEmbeddingTask,
  vector: number[],
  model: string,
): Promise<void> {
  const changed = await prisma.$executeRaw`
    UPDATE knowledge_chunks
    SET embedding = ${JSON.stringify(vector)}::vector,
        embedding_model = ${model},
        embedding_dimension = ${vector.length},
        embedding_content_hash = ${createHash('sha256').update(task.content).digest('hex')},
        embedded_at = NOW()
    WHERE id = ${task.id}::uuid
      AND ('角色：' || role || E'\n场景：' || scenario || E'\n触发：' || trigger || E'\n行动：' || action) = ${task.content}
  `;
  if (changed !== 1) throw new Error(`块 ${task.id} 的内容在向量生成期间发生变化，请重试`);
}
