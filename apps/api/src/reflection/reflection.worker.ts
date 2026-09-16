import { ModelGenerationService } from '../llm/model-generation.service';
import { JobModelStages } from '../llm/job-model-stages';
import { RedisService } from '../redis/redis.service';
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
    private readonly generations: ModelGenerationService,
    private readonly redis: RedisService,
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

  async process(job: Job<ReflectJobData>, token?: string): Promise<void> {
    token ??= job.token;
    if (!token) throw new Error('模型任务缺少 Worker 执行令牌');
    return this.generations.withJob(new JobModelStages(this.redis, job, token), () =>
      this.consume(job),
    );
  }

  private async consume(job: Job<ReflectJobData>): Promise<void> {
    const { gameId, playerId, force, suffix } = job.data;

    try {
      if (job.data.evaluationRunId)
        await this.judgeService.completeEvaluation(gameId, job.data.evaluationRunId);
      const game = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: { experiment: true },
      });
      const writeLearning = !game?.experiment;
      if (job.name === REFLECT_JOB_NAMES.player) {
        if (!playerId) throw new Error(`玩家反思任务缺少 playerId: ${job.id}`);
        await this.reflectionService.reflect(gameId, playerId, force ?? false, writeLearning);
        return;
      }

      // player 子任务全部完成后触发的聚合父任务；依赖关系本身就是完成信号。
      if (job.name === REFLECT_JOB_NAMES.complete) {
        // 全部玩家反思落库后，按局序触发记忆分层维护；幂等投递，重复调用复用已存在任务。
        if (writeLearning) await this.maintenanceService.enqueueForGame(gameId);
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
      const review = await this.gameReviewService.loadStoredReview(gameId);
      if (review && writeLearning) {
        await this.globalMemoryService.promotePatterns(gameId, review.patterns);
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
