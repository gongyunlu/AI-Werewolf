import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * 游戏对局任务数据
 */
export interface GameJobData {
  gameId: string;
}

/**
 * 队列状态
 */
export interface QueueStatus {
  status: 'pending' | 'active' | 'completed' | 'failed' | 'unknown';
  position?: number; // 在队列中的位置（pending 时有效）
}

/**
 * 游戏队列服务
 *
 * 职责：
 * 1. 管理游戏对局任务队列
 * 2. 投递游戏任务到队列
 * 3. 查询任务状态
 * 4. 控制任务生命周期（暂停/继续/取消）
 */
@Injectable()
export class GameQueueService implements OnModuleInit {
  private readonly logger = new Logger(GameQueueService.name);

  constructor(@InjectQueue('game-queue') private readonly queue: Queue<GameJobData>) {}

  async onModuleInit() {
    this.logger.log('GameQueueService 初始化完成');
  }

  /**
   * 添加游戏任务到队列
   *
   * @param gameId - 游戏对局ID
   * @returns Job ID
   */
  async addGameJob(gameId: string): Promise<string> {
    const job = await this.queue.add(
      'run-game',
      { gameId },
      {
        jobId: gameId,
        attempts: 3, // 失败后重试 3 次
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600, // 完成后 1 小时自动清理
          count: 100, // 最多保留 100 条完成记录
        },
        removeOnFail: {
          age: 86400,
        },
      },
    );
    return job.id!;
  }

  /**
   * 获取任务对象（用于暂停/取消操作）
   *
   * @param gameId - 游戏对局ID
   * @returns Job 对象或 undefined
   */
  async getJob(gameId: string) {
    return this.queue.getJob(gameId);
  }

  /**
   * 查询游戏任务状态
   *
   * @param gameId - 游戏对局ID
   * @returns 队列状态
   */
  async getJobStatus(gameId: string): Promise<QueueStatus> {
    const job = await this.queue.getJob(gameId);

    if (!job) {
      return { status: 'unknown' };
    }

    const state = await job.getState();

    // 如果是 waiting，计算在队列中的位置
    if (state === 'waiting') {
      const waitingJobs = await this.queue.getWaiting();
      const position = waitingJobs.findIndex((j) => j.id === gameId);
      return { status: 'pending', position: position >= 0 ? position + 1 : undefined };
    }

    // 映射状态
    const statusMap: Record<string, QueueStatus['status']> = {
      active: 'active',
      completed: 'completed',
      failed: 'failed',
      delayed: 'pending',
      paused: 'pending',
    };

    return { status: statusMap[state] || 'unknown' };
  }

  /**
   * 取消游戏任务（仅处理队列移除，中断执行由 GameExecutorService 处理）
   *
   * @param gameId - 游戏对局ID
   * @returns 是否成功从队列移除
   */
  async cancelJob(gameId: string): Promise<boolean> {
    const job = await this.queue.getJob(gameId);
    if (!job) {
      this.logger.warn(`任务不存在: ${gameId}`);
      return false;
    }

    const state = await job.getState();

    // 如果任务正在执行，返回 false（由调用方处理中断）
    if (state === 'active') {
      return false;
    }

    // 如果任务还在队列中，直接移除
    await job.remove();
    return true;
  }

  /**
   * 暂停队列（影响所有任务）
   */
  async pauseQueue(): Promise<void> {
    await this.queue.pause();
  }

  /**
   * 继续队列
   */
  async resumeQueue(): Promise<void> {
    await this.queue.resume();
  }

  /**
   * 清理资源
   */
  async onModuleDestroy() {
    await this.queue.close();
  }

  /**
   * 获取队列统计指标
   */
  async getMetrics() {
    return {
      waiting: await this.queue.getWaitingCount(),
      active: await this.queue.getActiveCount(),
      completed: await this.queue.getCompletedCount(),
      failed: await this.queue.getFailedCount(),
      delayed: await this.queue.getDelayedCount(),
      paused: await this.queue.isPaused(),
    };
  }
}
