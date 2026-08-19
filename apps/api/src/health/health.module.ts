import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BullModule } from '@nestjs/bullmq';
import { HealthController } from './health.controller';
import {
  PrismaHealthIndicator,
  RedisHealthIndicator,
  QueueHealthIndicator,
} from './health.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TerminusModule,
    PrismaModule,
    RedisModule,
    BullModule.registerQueue({ name: 'game-queue' }),
  ],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator, QueueHealthIndicator],
})
export class HealthModule {}
