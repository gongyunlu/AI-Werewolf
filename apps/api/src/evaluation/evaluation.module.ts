import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SettlementService } from './settlement.service';
import { JudgeService } from './judge.service';
import { JudgeQueueService } from './judge-queue.service';
import { JudgeWorkerService } from './judge.worker';
import { StatisticsService } from './statistics.service';
import { EvaluationController } from './evaluation.controller';

/**
 * 评估模块：对局结算+ 决策质量评估+ 统计
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'judge-queue' })],
  controllers: [EvaluationController],
  providers: [
    SettlementService,
    JudgeService,
    JudgeQueueService,
    JudgeWorkerService,
    StatisticsService,
  ],
  exports: [SettlementService, JudgeQueueService],
})
export class EvaluationModule {}
