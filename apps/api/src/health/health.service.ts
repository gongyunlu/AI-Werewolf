import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { GameJobData } from '../game-queue/game-queue.service';

/**
 * Prisma 健康指标
 */
@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.health.check(key).up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.health.check(key).down({ error: message });
    }
  }
}

/**
 * Redis 健康指标
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const result = await this.redis.ping();
      if (result !== 'PONG') {
        return this.health.check(key).down({ result });
      }
      return this.health.check(key).up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.health.check(key).down({ error: message });
    }
  }
}

/**
 * BullMQ 队列健康指标
 *
 * 检查规则：
 * - waiting（待处理）< 100 视为健康
 * - failed（失败）< 50 视为健康
 * - 超过阈值视为不健康，可能导致游戏响应慢或无法启动
 */
@Injectable()
export class QueueHealthIndicator {
  constructor(
    @InjectQueue('game-queue') private readonly queue: Queue<GameJobData>,
    private readonly health: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed');

      const isHealthy = counts.waiting < 100 && counts.failed < 50;

      const data = {
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
      };

      if (!isHealthy) {
        return this.health.check(key).down(data);
      }

      return this.health.check(key).up(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.health.check(key).down({ error: message });
    }
  }
}
