import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  GameQueueService,
  GAME_PRODUCER_QUEUE,
  createGameProducerQueue,
} from './game-queue.service';
import { GameWorkerService } from './game-worker.service';
import { PrismaModule } from '../prisma/prisma.module';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import type { Env } from '../config/env.validation';
import { SseModule } from '../sse/sse.module';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { GameDispatchService } from './game-dispatch.service';

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
      useFactory: (configService: ConfigService<Env, true>) => ({
        connection: {
          // 与生产者使用同一完整 URL，避免数据库、认证或 TLS 配置被手工解析遗漏。
          url: configService.get('REDIS_URL', { infer: true }),
          maxRetriesPerRequest: null,
        },
      }),
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
  providers: [
    GameQueueService,
    GameWorkerService,
    GameDispatchService,
    {
      provide: GAME_PRODUCER_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createGameProducerQueue(config.get('REDIS_URL')),
    },
  ],
  exports: [GameQueueService, GameDispatchService],
})
export class GameQueueModule {}
