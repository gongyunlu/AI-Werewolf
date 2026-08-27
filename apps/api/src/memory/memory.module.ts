import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { EmbeddingService } from './embedding.service';

@Module({
  providers: [MemoryService, EmbeddingService],
  exports: [MemoryService, EmbeddingService],
})
export class MemoryModule {}
