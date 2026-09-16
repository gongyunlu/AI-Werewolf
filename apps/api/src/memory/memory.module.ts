import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { Module } from '@nestjs/common';
import { ModelCallModule } from '../llm/model-call.module';
import { MemoryService } from './memory.service';
import { EmbeddingService } from './embedding.service';
import { GlobalMemoryService } from './global-memory.service';
import { AgentMemoryController } from './agent-memory.controller';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';

@Module({
  imports: [ModelCallModule, GameRecoveryModule],
  controllers: [AgentMemoryController],
  providers: [MemoryService, EmbeddingService, GlobalMemoryService, AdminTokenGuard],
  exports: [MemoryService, EmbeddingService, GlobalMemoryService],
})
export class MemoryModule {}
