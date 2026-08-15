import { Module } from '@nestjs/common';
import { GameExecutorService } from './game-executor.service';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { GameEngineModule } from '../game-engine/core/game-engine.module';
import { BroadcasterModule } from '../broadcaster/broadcaster.module';

/**
 * 游戏执行器模块
 */
@Module({
  imports: [AgentRuntimeModule, GameEngineModule, BroadcasterModule],
  providers: [GameExecutorService],
  exports: [GameExecutorService],
})
export class GameExecutorModule {}
