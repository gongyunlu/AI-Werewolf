import { Logger } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { aggregatePlayerScores } from './player-score';

const repositoryRoot = resolve(__dirname, '../../../..');

// .env.local 优先于 .env（dotenv 默认不覆盖已存在的 process.env 变量）
loadEnv({ path: resolve(repositoryRoot, '.env.local') });
loadEnv({ path: resolve(repositoryRoot, '.env') });

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

const logger = new Logger('RecomputePlayerScores');

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('缺少必要环境变量（DATABASE_URL）');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  await prisma.$connect();

  try {
    const gameArg = readOption('game');
    const limitArg = readOption('limit');
    const limit = limitArg !== undefined ? Number(limitArg) : undefined;

    const games = await prisma.game.findMany({
      where: gameArg ? { id: gameArg, status: 'finished' } : { status: 'finished' },
      select: { id: true },
      orderBy: { startedAt: 'asc' },
    });
    if (games.length === 0) {
      print('没有已完成的对局。');
      return;
    }

    const targets = limit !== undefined ? games.slice(0, limit) : games;

    let scoredTotal = 0;
    for (const game of targets) {
      try {
        const { scored, total } = await aggregatePlayerScores(prisma, game.id);
        scoredTotal += scored;
        print(`对局 ${game.id.slice(0, 8)}：聚合 ${scored}/${total} 名玩家的过程分`);
      } catch (error) {
        print(
          `对局 ${game.id.slice(0, 8)}：聚合失败，跳过（${
            error instanceof Error ? error.message : String(error)
          }）`,
        );
      }
    }
    print(`合计：${targets.length} 局，${scoredTotal} 名玩家已写入过程分`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
