import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { Job, UnrecoverableError } from 'bullmq';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GameJobData } from './game-queue.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GamePausedException } from '../game-engine/core/game-engine.exception';
import type { Env } from '../config/env.validation';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { PostGameAnalysisError } from '../game-executor/game-executor.exception';
import { Optional } from '@nestjs/common';
import {
  ExecutionOwnershipError,
  GameRecoveryService,
} from '../game-recovery/game-recovery.service';

/**
 * 游戏队列 Worker
 *
 * 职责：
 * 1. 从队列中消费游戏任务
 * 2. 调用 GameExecutorService 执行游戏
 * 3. 处理任务失败和重试
 */
// 装饰器在模块导入期求值，早于 ConfigModule 加载 .env，
// 因此这里只能读 process.env（容器/Shell 注入的变量此时可见）。
// .env 中的 GAME_WORKER_CONCURRENCY 已由 env.validation 校验，
// 如需让 .env 的值作用于并发数，请在启动命令前预载 dotenv。
@Processor('game-queue', {
  concurrency: parseInt(process.env.GAME_WORKER_CONCURRENCY || '1', 10),
})
export class GameWorkerService extends WorkerHost {
  constructor(
    private readonly gameExecutor: GameExecutorService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
    private readonly broadcaster: SseBroadcasterService,
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {
    super();
    // 直接注入 PinoLogger 而非 @InjectPinoLogger：后者按类名注册具名 provider，
    // 而具名 provider 由 LoggerModule.forRootAsync 在 ObservabilityModule 求值时
    // 对静态 decoratedLoggers 集合做快照生成；若本类文件晚于 ObservabilityModule
    // 加载，其 context 会因未及时入集合而解析失败。直接注入主 PinoLogger 与顺序无关。
    this.logger.setContext(GameWorkerService.name);
  }

  async process(job: Job<GameJobData>): Promise<void> {
    const { gameId } = job.data;
    // 检查点上线前入队的任务属于首次执行，不能因此省略对后继代次的隔离。
    const generation = job.data.generation ?? 1;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const startedAt = Date.now();

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true },
    });

    if (!game) {
      this.logger.warn({ gameId, jobId: job.id }, '对局不存在，跳过任务');
      return;
    }

    if (game.status === GAME_STATUSES.FINISHED) {
      this.logger.info({ gameId, jobId: job.id, attempt, maxAttempts }, '对局已结束，补投赛后分析');
      try {
        await this.gameExecutor.analyzeFinishedGame(gameId);
        this.logger.info(
          { gameId, jobId: job.id, attempt, durationMs: Date.now() - startedAt },
          '赛后分析补投完成',
        );
        return;
      } catch (error) {
        this.logger.warn(
          {
            gameId,
            jobId: job.id,
            attempt,
            maxAttempts,
            err: error instanceof Error ? error.message : String(error),
          },
          '赛后分析补投失败，保持 FINISHED 并交由队列重试',
        );
        throw error;
      }
    }

    if (game.status !== GAME_STATUSES.RUNNING) {
      this.logger.info(
        { gameId, jobId: job.id, status: game.status },
        '对局状态非 running，跳过任务',
      );
      return;
    }

    // BullMQ 失锁后会重新取出同一任务；这里等待人工恢复，不重新开始第一夜。
    if (job.stalledCounter > 0) {
      await this.recovery?.interrupt(gameId, generation);
      throw new UnrecoverableError('执行进程中断；有检查点的对局等待手动恢复，无检查点的对局中止');
    }

    this.logger.info({ gameId, jobId: job.id, attempt, maxAttempts }, '开始执行对局');

    try {
      await this.gameExecutor.executeGame(gameId, generation);
      this.logger.info(
        { gameId, jobId: job.id, attempt, durationMs: Date.now() - startedAt },
        '对局执行完成',
      );
    } catch (error) {
      if (error instanceof ExecutionOwnershipError) {
        this.logger.warn({ gameId, jobId: job.id }, '执行权已转移，旧任务退出');
        throw new UnrecoverableError(error.message);
      }
      // 如果是游戏暂停/取消异常，特殊处理
      if (error instanceof GamePausedException) {
        this.logger.info(
          { gameId, jobId: job.id, durationMs: Date.now() - startedAt },
          '对局被暂停或取消，正常退出',
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      // 只有 GameExecutor 在 engine.run 已完整返回后包装出的错误可以安全重试。
      // 下一 attempt 会从顶部 FINISHED 分支进入，只补投分析，不重放引擎。
      if (error instanceof PostGameAnalysisError) {
        this.logger.warn(
          { gameId, jobId: job.id, attempt, maxAttempts, err: message },
          '对局已完成但赛后分析失败，保持 FINISHED',
        );
        throw error;
      }

      // 任何引擎阶段未知错误都不可自动重放。即使清理数据库或 SSE 自身失败，
      // 最终也必须抛 UnrecoverableError，避免下一 attempt 从 RUNNING 初始状态再执行一遍事件。
      let cleanupError: unknown;
      let markedAborted = false;
      let persistedStatus: string | null | undefined;
      try {
        const cleanup = await this.prisma.game.updateMany({
          // 终局事务可能已经提交、只是客户端收到不确定失败；绝不能把 FINISHED 覆盖成 ABORTED。
          where: {
            id: gameId,
            status: GAME_STATUSES.RUNNING,
            OR: [{ execution: null }, { execution: { generation } }],
          },
          data: {
            status: GAME_STATUSES.ABORTED,
            endedAt: new Date(),
          },
        });
        markedAborted = cleanup.count > 0;
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }

      if (!markedAborted && !cleanupError) {
        try {
          const persisted = await this.prisma.game.findUnique({
            where: { id: gameId },
            select: { status: true },
          });
          persistedStatus = persisted?.status;
        } catch (statusReadFailure) {
          cleanupError = statusReadFailure;
        }
      }

      // game-end 的数据库事务可能已经提交，只是客户端在收到成功响应前断线。
      // 此时重放引擎仍然危险，但下一 attempt 从 FINISHED 分支只会补投分析，因而是安全的。
      if (persistedStatus === GAME_STATUSES.FINISHED) {
        this.logger.warn(
          { gameId, jobId: job.id, attempt, maxAttempts, err: message },
          '终局事务已提交但执行响应不确定，下一次仅补投赛后分析',
        );
        throw new PostGameAnalysisError(gameId, error);
      }

      if (markedAborted) {
        try {
          this.broadcaster.emit(gameId, { type: 'game.finished', winner: 'unknown' });
          this.broadcaster.complete(gameId);
        } catch (broadcastFailure) {
          cleanupError ??= broadcastFailure;
        }
      }

      this.logger.error(
        {
          gameId,
          jobId: job.id,
          attempt,
          maxAttempts,
          err: message,
          cleanupErr:
            cleanupError instanceof Error
              ? cleanupError.message
              : cleanupError
                ? String(cleanupError)
                : undefined,
          markedAborted,
          persistedStatus,
        },
        cleanupError
          ? '对局引擎失败且清理未完整完成，已阻止自动重放'
          : markedAborted
            ? '对局引擎失败且不可安全重放，标记为 aborted'
            : '对局引擎失败，但终局状态已由其他事务提交，未覆盖其状态',
      );
      throw new UnrecoverableError(message);
    }
  }
}
