import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import {
  PrismaHealthIndicator,
  RedisHealthIndicator,
  QueueHealthIndicator,
} from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly queueHealth: QueueHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: '就绪检查（DB + Redis + Queue）' })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.redisHealth.isHealthy('redis'),
      () => this.queueHealth.isHealthy('game-queue'),
    ]);
  }

  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: '存活检查（轻量级）' })
  liveness() {
    // 轻量级检查，仅验证进程是否响应
    return this.health.check([]);
  }
}
