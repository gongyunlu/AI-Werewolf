import { InjectFlowProducer, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer, Queue, type JobsOptions, type JobState } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

export const REFLECT_QUEUE_NAME = 'reflect-queue';
export const REFLECT_FLOW_PRODUCER = 'reflect-flow';

/**
 * 反思任务名。
 *
 * fanout 是 flow 的父任务：全部 judge 子任务完成后自动触发，先做对局级复盘，
 * 再按玩家投递 player 任务——复盘是所有玩家反思的共同输入，必须先完成。
 */
export const REFLECT_JOB_NAMES = {
  fanout: 'reflect-fanout',
  player: 'reflect-player',
  complete: 'reflect-complete',
} as const;

export interface ReflectFanoutJobData {
  evaluationRunId?: string;
  gameId: string;
  force?: boolean;
  /** 只反思指定玩家；缺省反思全部玩家 */
  playerId?: string;
  /** 强制重跑时追加到子任务 jobId 的后缀 */
  suffix?: string;
  /** judge 刚重跑过：reward 刷新失败时必须让 fanout 重试 */
  refreshRewards?: boolean;
  /** fanout 重试检查点：本次运行的复盘已经成功持久化 */
  reviewCompleted?: boolean;
}

export interface ReflectPlayerJobData {
  gameId: string;
  playerId: string;
  force?: boolean;
}

export type ReflectJobData = ReflectFanoutJobData & Partial<ReflectPlayerJobData>;

/**
 * 反思任务的投递参数。
 *
 * 不设 attempts 重试等待上游：judge 是否完成由 flow 的父子依赖表达，
 * 靠指数退避「等」judge 跑完在算术上根本等不到。
 */
export const REFLECT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400 },
};

/**
 * 复盘任务的 jobId。
 *
 * 分隔符必须是下划线：该任务会作为 flow 的父任务投递，而 FlowProducer 拒绝含冒号的 jobId
 * （普通 queue.add 不校验，只在 flow 路径炸）。格式在此收敛一处，避免调用方各写各的。
 */
export function buildReviewJobId(gameId: string, suffix = ''): string {
  return `review_${gameId}${suffix}`;
}

export function buildReflectionCompleteJobId(gameId: string, suffix = ''): string {
  return `reflect_complete_${gameId}${suffix}`;
}

// 调度不包含任何 LLM 调用，正常只需数秒；30 秒足够覆盖慢数据库，
// 又能在进程硬崩溃时先于 BullMQ stalled job 的下一轮恢复释放孤儿锁。
const SCHEDULE_LOCK_TTL_MS = 30_000;
const SCHEDULE_LOCK_RENEW_MS = 10_000;
const RELEASE_LOCK_SCRIPT = [
  'if redis.call("get", KEYS[1]) == ARGV[1] then',
  '  return redis.call("del", KEYS[1])',
  'end',
  'return 0',
].join('\n');
const RENEW_LOCK_SCRIPT = [
  'if redis.call("get", KEYS[1]) == ARGV[1] then',
  '  return redis.call("pexpire", KEYS[1], ARGV[2])',
  'end',
  'return 0',
].join('\n');

export interface ScheduleLease {
  /** 在不可逆的队列投递前确认本调用仍持有锁，并顺带续租。 */
  assertOwned(): Promise<void>;
}

export type ScheduleLockResult<T> = { acquired: false } | { acquired: true; value: T };

/** 反思队列服务：投递父任务与 per-player 子任务 */
@Injectable()
export class ReflectionQueueService {
  private readonly logger = new Logger(ReflectionQueueService.name);

  constructor(
    @InjectQueue(REFLECT_QUEUE_NAME) private readonly queue: Queue<ReflectJobData>,
    private readonly redis: RedisService,
    @InjectFlowProducer(REFLECT_FLOW_PRODUCER) private readonly flowProducer: FlowProducer,
  ) {}

  /**
   * 原子串行化同一对局的「检查现有任务 → 投递新 flow」。
   * 锁只覆盖快速的调度事务；后续运行期互斥由 hasInFlightFanout 同时检查 fanout/player jobs。
   */
  async withGameScheduleLock<T>(
    gameId: string,
    task: (lease: ScheduleLease) => Promise<T>,
  ): Promise<ScheduleLockResult<T>> {
    const key = `analysis:schedule:${gameId}`;
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', SCHEDULE_LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') return { acquired: false };

    let leaseLost = false;
    let renewalPromise: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (leaseLost) return;
      if (renewalPromise) return renewalPromise;

      renewalPromise = (async () => {
        try {
          const renewed = await this.redis.eval(
            RENEW_LOCK_SCRIPT,
            1,
            key,
            token,
            SCHEDULE_LOCK_TTL_MS,
          );
          if (Number(renewed) !== 1) leaseLost = true;
        } catch (error) {
          // 无法确认所有权时宁可放弃本次投递，也不能在锁已过期/易主后继续创建 force flow。
          leaseLost = true;
          this.logger.error(
            { gameId, err: error instanceof Error ? error.message : String(error) },
            '赛后分析调度锁续租失败',
          );
        } finally {
          renewalPromise = null;
        }
      })();
      return renewalPromise;
    };

    const timer = setInterval(() => void renew(), SCHEDULE_LOCK_RENEW_MS);
    timer.unref();
    const lease: ScheduleLease = {
      assertOwned: async () => {
        if (leaseLost) throw new Error(`对局 ${gameId} 的赛后分析调度锁已丢失`);
        await renew();
        if (leaseLost) throw new Error(`对局 ${gameId} 的赛后分析调度锁已丢失`);
      },
    };

    try {
      return { acquired: true, value: await task(lease) };
    } finally {
      clearInterval(timer);
      try {
        await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
      } catch (error) {
        // 释放失败不能把已经成功完成的 flow.add 伪报为失败；token + TTL 会安全清理孤儿锁。
        this.logger.warn(
          { gameId, err: error instanceof Error ? error.message : String(error) },
          '赛后分析调度锁释放失败，等待 TTL 清理',
        );
      }
    }
  }

  /**
   * 检查同一对局任意后缀的 fanout 或 player reflection 是否仍在运行。
   * force run 会使用新 jobId；必须覆盖全部在途 job，避免 fanout 刚完成、player 仍执行时
   * 又启动一版复盘。end=-1 不截断队列，防止任务多于固定窗口时漏检。
   */
  async hasInFlightFanout(gameId: string): Promise<boolean> {
    const jobs = await this.queue.getJobs(
      ['active', 'waiting', 'waiting-children', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
    return jobs.some(
      (job) =>
        (job.name === REFLECT_JOB_NAMES.fanout ||
          job.name === REFLECT_JOB_NAMES.player ||
          job.name === REFLECT_JOB_NAMES.complete) &&
        job.data.gameId === gameId,
    );
  }

  /** 查询稳定 fanout 的状态，用于让重复的非 force 请求复用正在进行的 flow */
  async getFanoutState(gameId: string, suffix = ''): Promise<JobState | null> {
    const job = await this.queue.getJob(buildReviewJobId(gameId, suffix));
    if (!job) return null;
    const state = await job.getState();
    return state === 'unknown' ? null : state;
  }

  /** 直接投递 fanout（跳过 judge、只重跑反思时使用） */
  async enqueueFanout(data: ReflectFanoutJobData): Promise<void> {
    await this.queue.add(REFLECT_JOB_NAMES.fanout, data, {
      ...REFLECT_JOB_OPTIONS,
      jobId: buildReviewJobId(data.gameId, data.suffix),
    });
  }

  /** 复盘完成后按玩家投递反思任务 */
  async enqueuePlayers(
    gameId: string,
    playerIds: string[],
    options: { force?: boolean; suffix?: string } = {},
  ): Promise<number> {
    if (playerIds.length === 0) return 0;

    const suffix = options.suffix ?? '';
    // 动态 fanout 后再建一段 player → complete flow。任一玩家耗尽重试时，
    // failParentOnFailure 会把 completion job 标失败，队列监控不会把部分反思误报成成功。
    await this.flowProducer.add({
      name: REFLECT_JOB_NAMES.complete,
      queueName: REFLECT_QUEUE_NAME,
      data: { gameId, suffix },
      opts: {
        ...REFLECT_JOB_OPTIONS,
        jobId: buildReflectionCompleteJobId(gameId, suffix),
      },
      children: playerIds.map((playerId) => ({
        name: REFLECT_JOB_NAMES.player,
        queueName: REFLECT_QUEUE_NAME,
        data: { gameId, playerId, force: options.force },
        opts: {
          ...REFLECT_JOB_OPTIONS,
          jobId: `reflect_${gameId}_${playerId}${suffix}`,
          failParentOnFailure: true,
        },
      })),
    });
    return playerIds.length;
  }
}
