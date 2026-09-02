import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MemoryModule } from '../memory/memory.module';
import { MEMORY_MAINTENANCE_QUEUE, MemoryMaintenanceService } from './memory-maintenance.service';
import { MaintenanceWorkerService } from './maintenance.worker';

/**
 * 记忆维护模块：独立队列承载每局结束后的分层维护（衰减/归档/去重/固化）。
 *
 * 复用 MemoryModule 的 EmbeddingService / MemoryService；Redis 连接已在 GameQueueModule forRoot。
 */
@Module({
  imports: [BullModule.registerQueue({ name: MEMORY_MAINTENANCE_QUEUE }), MemoryModule],
  providers: [MemoryMaintenanceService, MaintenanceWorkerService],
  exports: [MemoryMaintenanceService],
})
export class MemoryMaintenanceModule {}
