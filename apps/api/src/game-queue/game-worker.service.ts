import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GameJobData } from './game-queue.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GamePausedException } from '../game-engine/core/game-engine.exception';
import type { Env } from '../config/env.validation';

/**
 * 游戏队列 Worker
 *
 * 职责：
 * 1. 从队列中消费游戏任务
 * 2. 调用 GameExecutorService 执行游戏
 * 3. 处理任务失败和重试
 */
// 装饰器在模块导入期求值，早于 ConfigModule 加载 .env，
// 因此这里只能读 process.env（容器/Shell 注入的变量此时可见）。
// .env 中的 GAME_WORKER_CONCURRENCY 已由 env.validation 校验，
// 如需让 .env 的值作用于并发数，请在启动命令前预载 dotenv。
@Processor('game-queue', {
  concurrency: parseInt(process.env.GAME_WORKER_CONCURRENCY || '1', 10),
})
export class GameWorkerService extends WorkerHost {
  private readonly logger = new Logger(GameWorkerService.name);

  constructor(
    private readonly gameExecutor: GameExecutorService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<Env, true>,
  ) {
    super();
  }

  async process(job: Job<GameJobData>): Promise<void> {
    const { gameId } = job.data;

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true },
    });

    if (!game) {
      return;
    }

    if (game.status !== GAME_STATUSES.RUNNING) return;

    try {
      await this.gameExecutor.executeGame(gameId);
    } catch (error) {
      // 如果是游戏暂停/取消异常，特殊处理
      if (error instanceof GamePausedException) return;

      // 如果是最后一次尝试，标记为 aborted
      if (job.attemptsMade + 1 >= (job.opts.attempts || 3)) {
        await this.prisma.game.update({
          where: { id: gameId },
          data: {
            status: GAME_STATUSES.ABORTED,
            endedAt: new Date(),
          },
        });
        this.logger.error(`游戏任务已达最大重试次数，标记为 aborted: ${gameId}`);
      }
      // 重新抛出，触发 BullMQ 重试机制
      throw error;
    }
  }
}
