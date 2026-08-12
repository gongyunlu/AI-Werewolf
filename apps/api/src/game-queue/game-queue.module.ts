import { BullModule } from '@nestjs/bullmq';
import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GameQueueService } from './game-queue.service';
import { GameWorkerService } from './game-worker.service';
import { PrismaModule } from '../prisma/prisma.module';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import { PrismaService } from '../prisma/prisma.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import type { Env } from '../config/env.validation';

/**
 * 游戏队列模块
 *
 * 提供：
 * 1. GameQueueService - 队列管理
 * 2. GameWorkerService - 任务消费
 * 3. 后端重启自动标记 running 为 pending_recovery
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService<Env, true>) => {
        const redisUrl = configService.get('REDIS_URL', { infer: true });
        const url = new URL(redisUrl);

        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port) || 6379,
            password: url.password || undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'game-queue',
    }),
    ConfigModule,
    PrismaModule,
    GameExecutorModule,
  ],
  providers: [GameQueueService, GameWorkerService],
  exports: [GameQueueService],
})
export class GameQueueModule implements OnModuleInit {
  private readonly logger = new Logger(GameQueueModule.name);

  constructor(
    private readonly gameQueue: GameQueueService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // 查询所有 running 状态的游戏
    const runningGames = await this.prisma.game.findMany({
      where: { status: GAME_STATUSES.RUNNING },
      select: { id: true, startedAt: true },
    });

    if (runningGames.length === 0) {
      return;
    }

    // 检查每个游戏的队列状态
    for (const game of runningGames) {
      try {
        const job = await this.gameQueue.getJob(game.id);

        if (job) {
          const state = await job.getState();

          // 如果任务还在队列中（waiting/delayed），无需恢复
          if (state === 'waiting' || state === 'delayed') {
            continue;
          }

          // 如果任务正在执行（active），标记为待恢复（进程重启导致执行中断）
          if (state === 'active') {
            await this.prisma.game.update({
              where: { id: game.id },
              data: { status: GAME_STATUSES.PENDING_RECOVERY },
            });
            continue;
          }
        }

        await this.prisma.game.update({
          where: { id: game.id },
          data: { status: GAME_STATUSES.PENDING_RECOVERY },
        });
      } catch {
        // 出错时保守处理：标记为待恢复
        await this.prisma.game.update({
          where: { id: game.id },
          data: { status: GAME_STATUSES.PENDING_RECOVERY },
        });
      }
    }
  }
}
