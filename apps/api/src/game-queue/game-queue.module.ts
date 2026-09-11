import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GameQueueService } from './game-queue.service';
import { GameWorkerService } from './game-worker.service';
import { PrismaModule } from '../prisma/prisma.module';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import type { Env } from '../config/env.validation';
import { SseModule } from '../sse/sse.module';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';

/**
 * 游戏队列模块
 *
 * 提供：
 * 1. GameQueueService - 队列管理
 * 2. GameWorkerService - 任务消费
 * 3. 失锁任务由 Worker 标记为待恢复
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
    SseModule,
    GameRecoveryModule,
  ],
  providers: [GameQueueService, GameWorkerService],
  exports: [GameQueueService],
})
export class GameQueueModule {}
