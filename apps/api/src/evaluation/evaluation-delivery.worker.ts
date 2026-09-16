import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EvaluationProjectionService } from './evaluation-projection.service';
import { EVALUATION_DELIVERY_QUEUE } from './evaluation-delivery.service';

@Processor(EVALUATION_DELIVERY_QUEUE, { concurrency: 1 })
export class EvaluationDeliveryWorker extends WorkerHost {
  private readonly logger = new Logger(EvaluationDeliveryWorker.name);

  constructor(private readonly projection: EvaluationProjectionService) {
    super();
  }

  async process(job: Job<{ runId: string }>): Promise<void> {
    try {
      await this.projection.deliverPending(job.data.runId);
    } catch (error) {
      this.logger.error(
        { runId: job.data.runId, err: error instanceof Error ? error.message : String(error) },
        'Langfuse 评分上报失败，保留载荷稍后重试；本地评分不受影响',
      );
      throw error;
    }
  }
}
