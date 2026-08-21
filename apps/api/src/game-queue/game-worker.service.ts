import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { Job } from 'bullmq';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GameJobData } from './game-queue.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GamePausedException } from '../game-engine/core/game-engine.exception';
import type { Env } from '../config/env.validation';

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
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 3;
    const startedAt = Date.now();

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true },
    });

    if (!game) {
      this.logger.warn({ gameId, jobId: job.id }, '对局不存在，跳过任务');
      return;
    }

    if (game.status !== GAME_STATUSES.RUNNING) {
      this.logger.info(
        { gameId, jobId: job.id, status: game.status },
        '对局状态非 running，跳过任务',
      );
      return;
    }

    this.logger.info({ gameId, jobId: job.id, attempt, maxAttempts }, '开始执行对局');

    try {
      await this.gameExecutor.executeGame(gameId);
      this.logger.info(
        { gameId, jobId: job.id, attempt, durationMs: Date.now() - startedAt },
        '对局执行完成',
      );
    } catch (error) {
      // 如果是游戏暂停/取消异常，特殊处理
      if (error instanceof GamePausedException) {
        this.logger.info(
          { gameId, jobId: job.id, durationMs: Date.now() - startedAt },
          '对局被暂停或取消，正常退出',
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      // 如果是最后一次尝试，标记为 aborted
      if (attempt >= maxAttempts) {
        await this.prisma.game.update({
          where: { id: gameId },
          data: {
            status: GAME_STATUSES.ABORTED,
            endedAt: new Date(),
          },
        });
        this.logger.error(
          { gameId, jobId: job.id, attempt, maxAttempts, err: message },
          '对局任务已达最大重试次数，标记为 aborted',
        );
      } else {
        this.logger.warn(
          { gameId, jobId: job.id, attempt, maxAttempts, err: message },
          '对局执行失败，将由队列重试',
        );
      }
      // 重新抛出，触发 BullMQ 重试机制
      throw error;
    }
  }
}
