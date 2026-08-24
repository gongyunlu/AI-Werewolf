import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JudgeService } from './judge.service';
import type { JudgeJobData } from './judge-queue.service';

/**
 * judge 队列 Worker：消费 judge-decision 任务，调用 JudgeService 评估并落库。
 *
 * 失败重抛交由 BullMQ 指数退避重试（attempts:3）。
 */
@Processor('judge-queue', { concurrency: 2 })
export class JudgeWorkerService extends WorkerHost {
  private readonly logger = new Logger(JudgeWorkerService.name);

  constructor(private readonly judgeService: JudgeService) {
    super();
  }

  async process(job: Job<JudgeJobData>): Promise<void> {
    const { gameId, eventId } = job.data;
    try {
      await this.judgeService.judgeEvent(gameId, eventId);
    } catch (error) {
      this.logger.error(
        { gameId, eventId, err: error instanceof Error ? error.message : String(error) },
        '决策评估失败，交由队列重试',
      );
      throw error;
    }
  }
}
