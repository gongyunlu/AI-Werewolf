import { Module } from '@nestjs/common';
import { GameExecutorService } from './game-executor.service';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { GameEngineModule } from '../game-engine/core/game-engine.module';
import { EventsModule } from '../game-engine/events/events.module';
import { SseModule } from '../sse/sse.module';
import { EventBusModule } from '../event-bus/event-bus.module';
import { SpeechSummarizerModule } from '../speech-summarizer/speech-summarizer.module';
import { ReflectionModule } from '../reflection/reflection.module';

/**
 * 游戏执行器模块
 */
@Module({
  imports: [
    AgentRuntimeModule,
    GameEngineModule,
    EventsModule,
    SseModule,
    EventBusModule,
    SpeechSummarizerModule,
    ReflectionModule,
  ],
  providers: [GameExecutorService],
  exports: [GameExecutorService],
})
export class GameExecutorModule {}
