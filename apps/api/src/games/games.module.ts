import { Module } from '@nestjs/common';
import { GamesController } from './games.controller';
import { GamesService } from './games.service';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import { GameQueueModule } from '../game-queue/game-queue.module';

@Module({
  imports: [GameExecutorModule, GameQueueModule],
  controllers: [GamesController],
  providers: [GamesService],
  exports: [GamesService],
})
export class GamesModule {}
