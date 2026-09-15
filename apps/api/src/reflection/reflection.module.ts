import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { MemoryModule } from '../memory/memory.module';
import { MemoryMaintenanceModule } from '../memory-maintenance/memory-maintenance.module';
import { GameReviewService } from './game-review.service';
import { ReflectionService } from './reflection.service';
import {
  ReflectionQueueService,
  REFLECT_FLOW_PRODUCER,
  REFLECT_QUEUE_NAME,
} from './reflection-queue.service';
import { ReflectionWorkerService } from './reflection.worker';
import { GameAnalysisService } from './game-analysis.service';
import { AnalysisController } from './analysis.controller';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';

/**
 * 反思模块：对局级复盘 + 玩家级反思 + 赛后分析编排。
 *
 * Redis 连接在 GameQueueModule 里 forRoot，这里只注册队列与 flow producer。
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: REFLECT_QUEUE_NAME }),
    BullModule.registerFlowProducer({ name: REFLECT_FLOW_PRODUCER }),
    EvaluationModule,
    MemoryModule,
    MemoryMaintenanceModule,
  ],
  controllers: [AnalysisController],
  providers: [
    GameReviewService,
    ReflectionService,
    ReflectionQueueService,
    ReflectionWorkerService,
    GameAnalysisService,
    AdminTokenGuard,
  ],
  exports: [GameAnalysisService],
})
export class ReflectionModule {}
