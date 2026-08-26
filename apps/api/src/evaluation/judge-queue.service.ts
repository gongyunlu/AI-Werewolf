import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly prisma: PrismaService,
  ) {}

  /** 投递对局内全部可评估决策事件，返回投递数量 */
  async enqueueGame(gameId: string): Promise<number> {
    const eventIds = await this.judgeService.findJudgeableEvents(gameId);
    for (const eventId of eventIds) {
      // jobId 固定为 eventId：结算时首次投递，幂等防重复
      await this.addJob(gameId, eventId, eventId);
    }
    return eventIds.length;
  }

  /** 重评对局内全部可评估决策事件，返回投递数量 */
  async rejudgeGame(gameId: string): Promise<number> {
    const eventIds = await this.judgeService.findJudgeableEvents(gameId);
    const stamp = Date.now();
    for (const eventId of eventIds) {
      await this.addJob(gameId, eventId, `${eventId}:rejudge:${stamp}`);
    }
    return eventIds.length;
  }

  /** 重评所有已结束对局，返回 { games, decisions } */
  async rejudgeAll(): Promise<{ games: number; decisions: number }> {
    const finished = await this.prisma.game.findMany({
      where: { status: GAME_STATUSES.FINISHED },
      select: { id: true },
    });

    let decisions = 0;
    for (const game of finished) {
      decisions += await this.rejudgeGame(game.id);
    }

    return { games: finished.length, decisions };
  }

  private async addJob(gameId: string, eventId: string, jobId: string): Promise<void> {
    await this.queue.add(
      'judge-decision',
      { gameId, eventId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    );
  }
}
