import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JudgeService } from './judge.service';
import { JUDGE_JOB_NAMES, JUDGE_QUEUE_NAME, type JudgeJobData } from './judge-queue.service';

/**
 * judge 队列 Worker：按任务名分发到决策评估或发言批量评估，结果落库。
 *
 * 失败重抛交由 BullMQ 指数退避重试（attempts:3）。
 */
@Processor(JUDGE_QUEUE_NAME, { concurrency: 2 })
export class JudgeWorkerService extends WorkerHost {
  private readonly logger = new Logger(JudgeWorkerService.name);

  constructor(private readonly judgeService: JudgeService) {
    super();
  }

  async process(job: Job<JudgeJobData>): Promise<void> {
    const { gameId, eventId, playerId } = job.data;
    try {
      if (job.name === JUDGE_JOB_NAMES.complete) {
        // completion 只有在全部评分 child 成功后才会运行；回填失败必须重试，不能静默留下旧 reward。
        await this.judgeService.backfillRewards(gameId);
        return;
      }

      if (job.name === JUDGE_JOB_NAMES.speeches) {
        if (!playerId) throw new Error(`发言评估任务缺少 playerId: ${job.id}`);
        await this.judgeService.judgeSpeeches(gameId, playerId);
        return;
      }

      if (!eventId) throw new Error(`决策评估任务缺少 eventId: ${job.id}`);
      await this.judgeService.judgeEvent(gameId, eventId);
    } catch (error) {
      this.logger.error(
        {
          gameId,
          jobName: job.name,
          eventId,
          playerId,
          err: error instanceof Error ? error.message : String(error),
        },
        '评估失败，交由队列重试',
      );
      throw error;
    }
  }
}
