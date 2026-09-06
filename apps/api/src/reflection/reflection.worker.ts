import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { JudgeService } from '../evaluation/judge.service';
import { GlobalMemoryService } from '../memory/global-memory.service';
import { MemoryMaintenanceService } from '../memory-maintenance/memory-maintenance.service';
import { GameReviewService } from './game-review.service';
import { ReflectionService } from './reflection.service';
import {
  REFLECT_JOB_NAMES,
  REFLECT_QUEUE_NAME,
  ReflectionQueueService,
  type ReflectJobData,
} from './reflection-queue.service';

/**
 * 反思队列 Worker。
 *
 * fanout：作为 judge 子任务的父任务被自动触发，先做一次对局级复盘，再按玩家投递反思任务。
 * player：消费单个玩家的反思。
 */
@Processor(REFLECT_QUEUE_NAME, { concurrency: 2 })
export class ReflectionWorkerService extends WorkerHost {
  private readonly logger = new Logger(ReflectionWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgeService: JudgeService,
    private readonly gameReviewService: GameReviewService,
    private readonly reflectionService: ReflectionService,
    private readonly globalMemoryService: GlobalMemoryService,
    private readonly maintenanceService: MemoryMaintenanceService,
    private readonly queueService: ReflectionQueueService,
  ) {
    super();
  }

  async process(job: Job<ReflectJobData>): Promise<void> {
    const { gameId, playerId, force, suffix, refreshRewards } = job.data;

    try {
      if (job.name === REFLECT_JOB_NAMES.player) {
        if (!playerId) throw new Error(`玩家反思任务缺少 playerId: ${job.id}`);
        await this.reflectionService.reflect(gameId, playerId, force ?? false);
        return;
      }

      // player 子任务全部完成后触发的聚合父任务；依赖关系本身就是完成信号。
      if (job.name === REFLECT_JOB_NAMES.complete) {
        // 全部玩家反思落库后，按局序触发记忆分层维护；幂等投递，重复调用复用已存在任务。
        await this.maintenanceService.enqueueForGame(gameId);
        return;
      }

      if (job.name !== REFLECT_JOB_NAMES.fanout) {
        throw new Error(`未知反思任务类型: ${job.name}`);
      }

      // 复盘成功后把检查点写回 job.data。若之后的 reward 回填或玩家投递失败，
      // BullMQ 重试会复用已经落库的同一份复盘，避免同批玩家基于不同版本反思。
      if (!job.data.reviewCompleted) {
        await this.gameReviewService.reviewGame(gameId, force ?? false);
        await job.updateData({ ...job.data, reviewCompleted: true });
      }

      // 全局 pattern 晋升：幂等，无论本次还是上次重试生成的复盘，都从已存 narrative 取回聚类。
      // 放在 reviewCompleted 检查点之外，避免 reviewGame 成功但后续步骤失败重试时漏跑晋升。
      const review = await this.gameReviewService.loadReview(gameId);
      if (review) {
        await this.globalMemoryService.promotePatterns(gameId, review.patterns);
      }

      // combined flow 的 judge 已刚刚重跑：backfillRewards 会全量刷新变化过的 reward。
      // 该路径回填失败会让 fanout 重试，避免反思已完成但 lesson 质量信号仍停留在旧版本。
      if (refreshRewards) {
        await this.judgeService.backfillRewards(gameId);
        await this.judgeService.aggregatePlayerScores(gameId);
      } else {
        // 只跑反思时没有产生新评分，回填是尽力补历史空值，不阻断复盘。
        try {
          await this.judgeService.backfillRewards(gameId);
          await this.judgeService.aggregatePlayerScores(gameId);
        } catch (error) {
          this.logger.warn(
            { gameId, err: error instanceof Error ? error.message : String(error) },
            'reward 回填失败，跳过',
          );
        }
      }

      const playerIds = playerId
        ? [playerId]
        : (
            await this.prisma.player.findMany({
              where: { gameId },
              select: { id: true },
              orderBy: { seatNo: 'asc' },
            })
          ).map((p) => p.id);

      await this.queueService.enqueuePlayers(gameId, playerIds, { force, suffix });
    } catch (error) {
      this.logger.error(
        {
          gameId,
          jobName: job.name,
          playerId,
          err: error instanceof Error ? error.message : String(error),
        },
        '反思任务失败，交由队列重试',
      );
      throw error;
    }
  }
}
