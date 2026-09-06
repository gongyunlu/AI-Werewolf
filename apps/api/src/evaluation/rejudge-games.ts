import { Logger } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

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

const logger = new Logger('RejudgeGames');

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * AnalysisController 的 analyze 端点限流为 10 req / 60s（@Throttle），
 * 批量重评按此分批：每批并发投递 10 局，批间等待窗口滑出，避免触发 429。
 */
const BATCH_SIZE = 10;
const BATCH_INTERVAL_MS = 61_000;

interface RejudgeResult {
  judged: number;
  skipped: boolean;
}

/**
 * 通过 analyze 端点触发单局「决策 + 发言」强制重评（judge=true, reflect=false, force=true）。
 *
 * 复用 GameAnalysisService.analyzeGame 的完整语义：先幂等结算、再查在途流程防交错、
 * force 后缀绕过幂等重新投递 judge flow。真正的 LLM 评分由 API 进程内的 JudgeWorker
 * 消费队列完成，脚本只负责投递。
 */
async function triggerRejudge(baseUrl: string, gameId: string): Promise<RejudgeResult> {
  const response = await fetch(`${baseUrl}/evaluation/games/${gameId}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ judge: true, reflect: false, force: true }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status} ${detail}`);
  }

  return (await response.json()) as RejudgeResult;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('缺少必要环境变量（DATABASE_URL）');
  }
  const apiPort = process.env.API_PORT ?? '3001';
  const baseUrl = readOption('base-url') ?? `http://localhost:${apiPort}/api`;

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
    print(`待重评 ${targets.length} 局，base-url=${baseUrl}`);

    let judgedTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((game) => triggerRejudge(baseUrl, game.id)),
      );

      results.forEach((result, index) => {
        const game = batch[index];
        if (result.status === 'fulfilled') {
          judgedTotal += result.value.judged;
          if (result.value.skipped) {
            skippedTotal += 1;
            print(`对局 ${game.id.slice(0, 8)}：已有流程在途，跳过`);
          } else {
            print(`对局 ${game.id.slice(0, 8)}：投递 ${result.value.judged} 个评分任务`);
          }
        } else {
          failedTotal += 1;
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          print(`对局 ${game.id.slice(0, 8)}：失败（${reason}）`);
        }
      });

      const done = Math.min(i + BATCH_SIZE, targets.length);
      if (done < targets.length) {
        print(`已投递 ${done}/${targets.length}，等待限流窗口…`);
        await sleep(BATCH_INTERVAL_MS);
      }
    }

    print(
      `合计：${targets.length} 局，投递 ${judgedTotal} 个评分任务，跳过 ${skippedTotal}，失败 ${failedTotal}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
