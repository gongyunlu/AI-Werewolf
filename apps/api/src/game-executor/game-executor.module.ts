import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { GameExecutorService } from './game-executor.service';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { GameEngineModule } from '../game-engine/core/game-engine.module';
import { EventsModule } from '../game-engine/events/events.module';
import { SseModule } from '../sse/sse.module';
import { EventBusModule } from '../event-bus/event-bus.module';
import { SpeechSummarizerModule } from '../speech-summarizer/speech-summarizer.module';
import { ReflectionModule } from '../reflection/reflection.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GameEngineFactory } from './game-engine.factory';

/**
 * 游戏执行器模块
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ObservabilityModule,
    GameRecoveryModule,
    AgentRuntimeModule,
    GameEngineModule,
    EventsModule,
    SseModule,
    EventBusModule,
    SpeechSummarizerModule,
    ReflectionModule,
  ],
  providers: [GameEngineFactory, GameExecutorService],
  exports: [GameExecutorService],
})
export class GameExecutorModule {}
