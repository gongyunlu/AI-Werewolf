import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { BatchService } from './batch.service';
import { BatchController } from './batch.controller';

/**
 * 批量跑局
 */
@Module({
  imports: [GamesModule],
  controllers: [BatchController],
  providers: [BatchService],
})
export class BatchModule {}
