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
import { VoteTurnAdapter } from './vote-turn.adapter';
import { VOTE_TURN_PORT } from '../game-engine/ports/vote-turn.port';

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
  providers: [
    GameEngineFactory,
    VoteTurnAdapter,
    { provide: VOTE_TURN_PORT, useExisting: VoteTurnAdapter },
    GameExecutorService,
  ],
  exports: [GameExecutorService, VOTE_TURN_PORT, VoteTurnAdapter],
})
export class GameExecutorModule {}
