import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [MemoryModule],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
