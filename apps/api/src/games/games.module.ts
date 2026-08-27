import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameStreamController } from './game-stream.controller';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import { GameQueueModule } from '../game-queue/game-queue.module';
import { SseModule } from '../sse/sse.module';
import { GameLaunchService } from './game-launch.service';

@Module({
  imports: [GameExecutorModule, GameQueueModule, SseModule],
  controllers: [GamesController, GameStreamController],
  providers: [GamesService, GameLaunchService],
  exports: [GamesService, GameLaunchService],
})
export class GamesModule {}
