import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { BatchService } from './batch.service';
import { BatchController } from './batch.controller';
import { MemoryModule } from '../memory/memory.module';
import { SkillLoaderModule } from '../skills/skill-loader.module';

/**
 * 批量跑局
 */
@Module({
  imports: [GamesModule, MemoryModule, SkillLoaderModule],
  controllers: [BatchController],
  providers: [BatchService],
})
export class BatchModule {}
