import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { GamesModule } from './games/games.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AgentsModule } from './agents/agents.module';
import { AgentRuntimeModule } from './agent-runtime/agent-runtime.module';
import { EventBusModule } from './event-bus/event-bus.module';
import { GameEngineModule } from './game-engine/core/game-engine.module';
import { RulesetsModule } from './rulesets/rulesets.module';
import { GameQueueModule } from './game-queue/game-queue.module';
import { GameExecutorModule } from './game-executor/game-executor.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 数组前项优先：.env.local（本地私密覆盖）> .env（仓库/生产默认）
      envFilePath: [join(__dirname, '../../../.env.local'), join(__dirname, '../../../.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    GamesModule,
    AgentsModule,
    RulesetsModule,
    AgentRuntimeModule,
    EventBusModule,
    GameEngineModule,
    GameExecutorModule,
    GameQueueModule,
    HealthModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }], // 每 IP 每分钟最多 100 次请求
    }),
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
