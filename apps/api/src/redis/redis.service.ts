import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.validation';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(config: ConfigService<Env, true>) {
    super(config.get('REDIS_URL', { infer: true }));
    this.on('error', (err) => this.logger.error('Redis 连接错误', err));
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
