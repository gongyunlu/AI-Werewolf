import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { GameQueueModule } from '../game-queue/game-queue.module';
import { BatchService } from './batch.service';
import { BatchController } from './batch.controller';

/**
 * 批量跑局
 */
@Module({
  imports: [GamesModule, GameQueueModule],
  controllers: [BatchController],
  providers: [BatchService],
})
export class BatchModule {}
