import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer, Queue, type JobsOptions, type JobState } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import { JudgeService } from './judge.service';

export const JUDGE_QUEUE_NAME = 'judge-queue';
export const JUDGE_FLOW_PRODUCER = 'judge-flow';

/** judge 任务名：决策逐条评，发言按玩家整局批量评 */
export const JUDGE_JOB_NAMES = {
  decision: 'judge-decision',
  speeches: 'judge-speeches',
  complete: 'judge-complete',
} as const;

/** judge 任务数据（按 job.name 区分形状） */
export interface JudgeJobData {
  gameId: string;
  eventId?: string;
  playerId?: string;
}

/** 一条待投递的 judge 任务，可直接入队，也可作为 flow 的 child */
export interface JudgeJobSpec {
  name: string;
  data: JudgeJobData;
  jobId: string;
}

export function buildJudgeCompleteJobId(gameId: string, suffix = ''): string {
  return `judge_complete_${gameId}${suffix}`;
}

/** judge 任务的统一投递参数 */
export const JUDGE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

/**
 * judge 队列服务：对局结束后找出所有待评估目标并投递
 */
@Injectable()
export class JudgeQueueService {
  private readonly logger = new Logger(JudgeQueueService.name);

  constructor(
    @InjectQueue(JUDGE_QUEUE_NAME) private readonly queue: Queue<JudgeJobData>,
    private readonly judgeService: JudgeService,
    private readonly prisma: PrismaService,
    @InjectFlowProducer(JUDGE_FLOW_PRODUCER) private readonly flowProducer: FlowProducer,
  ) {}

  /** 同局任一评分或严格 reward completion 仍在途时，阻止 force 批次交错。 */
  async hasInFlightGame(gameId: string): Promise<boolean> {
    const jobs = await this.queue.getJobs(
      ['active', 'waiting', 'waiting-children', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
    return jobs.some((job) => job.data.gameId === gameId);
  }

  /** 查询 judge-only 稳定 completion 的状态；终态仍保留时恢复批次必须换 child jobId。 */
  async getCompletionState(gameId: string, suffix = ''): Promise<JobState | null> {
    const job = await this.queue.getJob(buildJudgeCompleteJobId(gameId, suffix));
    if (!job) return null;
    const state = await job.getState();
    return state === 'unknown' ? null : state;
  }

  /**
   * 列出对局的全部 judge 任务：每个可评估决策一条 + 每个发过言的玩家一条。
   *
   * jobId 一律用下划线分隔：这些任务会作为 flow 的 child 投递，
   * 而 FlowProducer 会拒绝含冒号的 jobId（普通 queue.add 不校验，只在 flow 路径炸）。
   *
   * @param suffix - 追加到 jobId 的后缀，用于强制重跑（缺省时 jobId 天然幂等）
   */
  async listGameJobs(gameId: string, suffix = ''): Promise<JudgeJobSpec[]> {
    const [eventIds, playerIds] = await Promise.all([
      this.judgeService.findJudgeableEvents(gameId),
      this.judgeService.findSpeakingPlayers(gameId),
    ]);

    return [
      ...eventIds.map((eventId) => ({
        name: JUDGE_JOB_NAMES.decision,
        data: { gameId, eventId },
        jobId: `${eventId}${suffix}`,
      })),
      ...playerIds.map((playerId) => ({
        name: JUDGE_JOB_NAMES.speeches,
        data: { gameId, playerId },
        jobId: `speeches_${gameId}_${playerId}${suffix}`,
      })),
    ];
  }

  /** 投递对局内全部待评估目标，返回投递数量 */
  async enqueueGame(gameId: string, suffix = ''): Promise<number> {
    return this.enqueueGameFlow(gameId, suffix);
  }

  /** 重评对局内全部待评估目标，返回投递数量 */
  async rejudgeGame(gameId: string): Promise<number> {
    return this.enqueueGameFlow(gameId, `_rejudge_${Date.now()}`);
  }

  /**
   * judge-only 也使用 completion barrier：全部评分成功后才严格刷新 memory reward。
   * 任一 child 耗尽重试会直接使 completion 失败；backfill 自身则按 completion attempts 重试。
   */
  private async enqueueGameFlow(gameId: string, suffix = ''): Promise<number> {
    const jobs = await this.listGameJobs(gameId, suffix);
    const completion = {
      name: JUDGE_JOB_NAMES.complete,
      queueName: JUDGE_QUEUE_NAME,
      data: { gameId },
      opts: {
        ...JUDGE_JOB_OPTIONS,
        jobId: buildJudgeCompleteJobId(gameId, suffix),
      },
    };

    if (jobs.length === 0) {
      await this.queue.add(completion.name, completion.data, completion.opts);
      return 0;
    }

    await this.flowProducer.add({
      ...completion,
      children: jobs.map((job) => ({
        name: job.name,
        queueName: JUDGE_QUEUE_NAME,
        data: job.data,
        opts: {
          ...JUDGE_JOB_OPTIONS,
          jobId: job.jobId,
          failParentOnFailure: true,
        },
      })),
    });
    return jobs.length;
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
}
