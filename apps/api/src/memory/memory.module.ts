import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { EmbeddingService } from './embedding.service';
import { GlobalMemoryService } from './global-memory.service';

@Module({
  providers: [MemoryService, EmbeddingService, GlobalMemoryService],
  exports: [MemoryService, EmbeddingService, GlobalMemoryService],
})
export class MemoryModule {}
