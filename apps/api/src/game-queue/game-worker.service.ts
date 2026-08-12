import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GameJobData } from './game-queue.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GamePausedException } from '../game-engine/core/game-engine.exception';

/**
 * 游戏队列 Worker
 *
 * 职责：
 * 1. 从队列中消费游戏任务
 * 2. 调用 GameExecutorService 执行游戏
 * 3. 处理任务失败和重试
 */
@Processor('game-queue', {
  concurrency: parseInt(process.env.GAME_WORKER_CONCURRENCY || '1', 10),
})
export class GameWorkerService extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(GameWorkerService.name);

  constructor(
    private readonly gameExecutor: GameExecutorService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async onModuleInit() {
    const concurrency = parseInt(process.env.GAME_WORKER_CONCURRENCY || '1', 10);
    this.logger.log(`GameWorkerService 已启动，并发数: ${concurrency}`);
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
