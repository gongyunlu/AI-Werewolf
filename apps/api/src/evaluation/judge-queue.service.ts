import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JudgeService } from './judge.service';

/** judge 任务数据 */
export interface JudgeJobData {
  gameId: string;
  eventId: string;
}

/**
 * judge 队列服务：对局结束后找出所有可评估决策事件并逐个投递
 */
@Injectable()
export class JudgeQueueService {
  private readonly logger = new Logger(JudgeQueueService.name);

  constructor(
    @InjectQueue('judge-queue') private readonly queue: Queue<JudgeJobData>,
    private readonly judgeService: JudgeService,
  ) {}

  /** 投递对局内全部可评估决策事件，返回投递数量 */
  async enqueueGame(gameId: string): Promise<number> {
    const eventIds = await this.judgeService.findJudgeableEvents(gameId);
    for (const eventId of eventIds) {
      await this.queue.add(
        'judge-decision',
        { gameId, eventId },
        {
          jobId: eventId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400 },
        },
      );
    }
    return eventIds.length;
  }
}
