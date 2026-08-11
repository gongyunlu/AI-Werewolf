import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameExecutorService } from './game-executor.service';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { GameEngineModule } from '../game-engine/core/game-engine.module';

@Module({
  imports: [AgentRuntimeModule, GameEngineModule],
  controllers: [GamesController],
  providers: [GamesService, GameExecutorService],
  exports: [GamesService],
})
export class GamesModule {}
