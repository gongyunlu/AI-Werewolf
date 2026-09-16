import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { GameQueueService } from './game-queue.service';

/** 扫描持久启动意图；Redis 接收成功不能代替数据库领取。 */
@Injectable()
export class GameDispatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GameDispatchService.name);
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: GameQueueService,
    private readonly recovery: GameRecoveryService,
  ) {}

  async dispatch(gameId: string): Promise<void> {
    let execution = await this.prisma.gameExecution.findUnique({
      where: { gameId },
      include: { game: { select: { status: true } } },
    });
    if (!execution?.dispatchPending || execution.game.status !== 'running') return;
    const job = await this.queue.getJob(gameId, execution.generation);
    if (job) {
      const state = await job.getState();
      if (
        ['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'].includes(
          state,
        )
      )
        return;
      if (state !== 'failed' && state !== 'completed')
        throw new Error(`游戏任务状态不确定：${gameId} / ${state}`);
      const next = await this.recovery.renewDispatch(gameId, execution.generation);
      execution = { ...execution, ...next };
    }
    await this.queue.addGameJob(gameId, execution.generation);
    // 一直保留到 Worker 领取，覆盖入队响应丢失、领取前失锁及队列任务被移除。
  }

  async dispatchPending(): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.gameExecution.findMany({
        where: { dispatchPending: true, game: { status: 'running' } },
        select: { gameId: true },
        orderBy: { gameId: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { gameId: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        try {
          await this.dispatch(row.gameId);
        } catch (error) {
          this.logger.error({ gameId: row.gameId, error }, '启动投递失败，保留意图等待补投');
        }
      }
      if (rows.length < 100) return;
      cursor = rows.at(-1)!.gameId;
    }
  }

  private scan() {
    this.scanning ??= this.dispatchPending()
      .catch((error) => this.logger.error({ error }, '无法扫描启动投递意图'))
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  async onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.scan();
    }, 5_000);
    this.timer.unref();
    await this.scan();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.scanning;
  }
}
