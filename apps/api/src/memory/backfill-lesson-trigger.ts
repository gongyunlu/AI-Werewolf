import { Logger } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { createCliModels } from '../llm/cli-models';
import { z } from 'zod';
import { RoleSchema } from '@ai-werewolf/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const repositoryRoot = resolve(__dirname, '../../../..');

// .env.local 优先于 .env（dotenv 默认不覆盖已存在的 process.env 变量）
loadEnv({ path: resolve(repositoryRoot, '.env.local') });
loadEnv({ path: resolve(repositoryRoot, '.env') });

/** 回填输出：角色 + 场景两个枚举，any 表示不限 */
const TriggerTagSchema = z.object({
  role: RoleSchema.or(z.literal('any')),
  scenario: z.enum([
    'vote',
    'day_speech',
    'night_action',
    'last_words',
    'sheriff_decide_order',
    'any',
  ]),
});
type TriggerTag = z.infer<typeof TriggerTagSchema>;

type RawExecutor = Pick<PrismaClient, '$executeRaw'>;

/** 合并标签时兼容历史 metadata=NULL，并保留既有 trigger/action/evidence。 */
export async function updateLessonMetadata(
  executor: RawExecutor,
  memoryId: string,
  tag: TriggerTag,
): Promise<number> {
  return executor.$executeRaw`
    UPDATE memories
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(tag)}::jsonb
    WHERE id = ${memoryId}::uuid
  `;
}

const SYSTEM_PROMPT = [
  '你是狼人杀经验教训的分类器。给定一条经验，判断它适用于哪个角色、哪个场景。',
  '- role：适用角色的英文枚举（villager/seer/witch/hunter/guard/werewolf/wolf_king 等）；只有对任何身份都成立才填 any',
  '- scenario：适用场景的英文枚举（vote=投票/day_speech=白天发言/night_action=夜间行动/last_words=遗言/sheriff_decide_order=警长定序）；跨场景才填 any',
].join('\n');

const logger = new Logger('LessonTriggerBackfill');

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ARK_API_KEY;
  const modelName = process.env.ARK_DEFAULT_MODEL;
  const baseUrl = process.env.ARK_BASE_URL;
  if (!databaseUrl || !apiKey || !modelName || !baseUrl) {
    throw new Error('缺少必要环境变量（DATABASE_URL/ARK_API_KEY/ARK_DEFAULT_MODEL/ARK_BASE_URL）');
  }

  const models = createCliModels();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    await prisma.$connect();
    const rows = await prisma.$queryRaw<Array<{ id: string; trigger: string; action: string }>>`
      SELECT id,
             COALESCE(metadata->>'trigger', content) AS trigger,
             COALESCE(metadata->>'action', content) AS action
      FROM memories
      WHERE type = 'lesson'
        AND is_active = true
        AND (metadata->>'role' IS NULL OR metadata->>'scenario' IS NULL)
      ORDER BY created_at
    `;

    if (rows.length === 0) {
      logger.log('没有需要回填的 lesson');
      return;
    }

    let done = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const { output: tag } = await models.generations.invoke({
          schema: TriggerTagSchema,
          system: SYSTEM_PROMPT,
          user: `触发条件：${row.trigger}\n行动：${row.action}`,
          modelName,
          runName: 'lesson-trigger',
          scenario: 'memory',
          gameId: 'lesson-backfill',
          playerId: row.id,
          signal: models.signal,
        });
        // 用 jsonb 合并追加 role/scenario，保留原有 trigger/action/evidence
        await updateLessonMetadata(prisma, row.id, tag);
        done += 1;
      } catch (error) {
        models.signal.throwIfAborted();
        failed += 1;
        logger.warn(
          `回填失败 id=${row.id}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    logger.log(`lesson trigger 回填完成：成功 ${done} 条，失败 ${failed} 条`);
  } finally {
    try {
      await models.close();
    } finally {
      await prisma.$disconnect();
    }
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
