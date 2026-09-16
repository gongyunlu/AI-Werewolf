import { EvaluationProjectionService } from './evaluation-projection.service';
import { LangfuseScoresService } from './langfuse-scores.service';
import {
  EvaluationDeliveryService,
  EVALUATION_DELIVERY_QUEUE,
} from './evaluation-delivery.service';
import { EvaluationDeliveryWorker } from './evaluation-delivery.worker';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SettlementService } from './settlement.service';
import { JudgeService } from './judge.service';
import { JudgeQueueService, JUDGE_FLOW_PRODUCER, JUDGE_QUEUE_NAME } from './judge-queue.service';
import { JudgeWorkerService } from './judge.worker';
import { StatisticsService } from './statistics.service';
import { EvaluationController } from './evaluation.controller';

/**
 * 评估模块：对局结算+ 决策质量评估+ 统计
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: JUDGE_QUEUE_NAME }),
    BullModule.registerQueue({ name: EVALUATION_DELIVERY_QUEUE }),
    BullModule.registerFlowProducer({ name: JUDGE_FLOW_PRODUCER }),
  ],
  controllers: [EvaluationController],
  providers: [
    EvaluationProjectionService,
    LangfuseScoresService,
    EvaluationDeliveryService,
    EvaluationDeliveryWorker,
    SettlementService,
    JudgeService,
    JudgeQueueService,
    JudgeWorkerService,
    StatisticsService,
  ],
  exports: [SettlementService, JudgeService, JudgeQueueService],
})
export class EvaluationModule {}
