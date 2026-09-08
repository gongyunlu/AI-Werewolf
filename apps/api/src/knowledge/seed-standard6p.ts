import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { EmbeddingService } from '../memory/embedding.service';
import { validateEnv } from '../config/env.validation';
import { STANDARD6P_TACTICS, STANDARD6P_KNOWLEDGE_VERSION as version } from './standard6p-tactics';
import { knowledgeSourceHash, knowledgeEmbeddingText } from './knowledge-policy';

const root = resolve(__dirname, '../../../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });

async function main() {
  const env = validateEnv(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    const rows = STANDARD6P_TACTICS.map((t) =>
      Object.assign({}, t, {
        sourceFile: 'curated/standard6p',
        articleTitle: t.id,
        content: knowledgeEmbeddingText(t),
      }),
    );
    const old = await prisma.knowledgeChunk.findMany({
      select: {
        id: true,
        sourceFile: true,
        articleTitle: true,
        content: true,
        isActive: true,
        version: true,
      },
    });
    const seen = new Set<string>();
    const duplicates = old.filter((row) => {
      const hash = knowledgeSourceHash(row);
      if (seen.has(hash)) return row.isActive;
      seen.add(hash);
      return false;
    });
    if (!process.argv.includes('--apply')) {
      process.stdout.write(
        JSON.stringify(
          {
            mode: 'preview',
            version,
            tactics: rows,
            duplicateActiveIds: duplicates.map((r) => r.id),
          },
          null,
          2,
        ),
      );
      return;
    }
    const embedding = new EmbeddingService(new ConfigService(env));
    for (const row of rows) {
      const sourceHash = knowledgeSourceHash(row);
      const saved = await prisma.knowledgeChunk.upsert({
        where: { version_sourceHash: { version, sourceHash } },
        update: {},
        create: {
          sourceHash,
          version,
          sourceFile: row.sourceFile,
          articleTitle: row.articleTitle,
          role: row.role,
          scenario: row.scenario,
          trigger: row.trigger,
          action: row.action,
          content: row.content,
          applicability: row.applicability,
          isActive: false,
        },
      });
      const hash = createHash('sha256').update(row.content).digest('hex');
      const ready = await prisma.$queryRaw<
        Array<{ ready: boolean }>
      >`SELECT embedding IS NOT NULL AND embedding_model = ${embedding.model} AND embedding_content_hash = ${hash} AS ready FROM knowledge_chunks WHERE id = ${saved.id}::uuid`;
      if (!ready[0]?.ready) {
        const vector = await embedding.embedText(row.content);
        await prisma.$executeRaw`UPDATE knowledge_chunks SET embedding = ${JSON.stringify(vector)}::vector,
          embedding_model = ${embedding.model}, embedding_dimension = ${embedding.dimension}, embedding_content_hash = ${hash}, embedded_at = NOW()
          WHERE id = ${saved.id}::uuid`;
      }
    }
    // 全部向量成功后统一启用；旧块只停用，保留历史注入关系。
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.updateMany({
        where: { id: { in: duplicates.map((r) => r.id) } },
        data: { isActive: false },
      });
      await tx.knowledgeChunk.updateMany({ where: { version }, data: { isActive: true } });
    });
    process.stdout.write(
      JSON.stringify({ version, activated: rows.length, duplicatesDeactivated: duplicates.length }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
