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
    const { gameId, eventId, playerId, runId } = job.data;
    try {
      if (job.name === JUDGE_JOB_NAMES.complete) {
        // completion 只有在全部评分 child 成功后才会运行；落投影与刷新 reward 在同一事务里，
        // 任一环节失败都会让整次 completion 重试，不在 worker 里再补一遍回填。
        await this.judgeService.completeEvaluation(gameId, runId);
        await this.judgeService.aggregatePlayerScores(gameId);
        return;
      }

      if (job.name === JUDGE_JOB_NAMES.speeches) {
        if (!playerId) throw new Error(`发言评估任务缺少 playerId: ${job.id}`);
        await this.judgeService.judgeSpeeches(gameId, playerId, undefined, runId);
        return;
      }

      if (!eventId) throw new Error(`决策评估任务缺少 eventId: ${job.id}`);
      await this.judgeService.judgeEvent(gameId, eventId, runId);
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
