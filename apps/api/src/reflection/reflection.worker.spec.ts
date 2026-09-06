import type { Job } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import type { JudgeService } from '../evaluation/judge.service';
import type { GameReviewService } from './game-review.service';
import type { ReflectionService } from './reflection.service';
import type { GlobalMemoryService } from '../memory/global-memory.service';
import type { MemoryMaintenanceService } from '../memory-maintenance/memory-maintenance.service';
import {
  REFLECT_JOB_NAMES,
  type ReflectJobData,
  type ReflectionQueueService,
} from './reflection-queue.service';
import { ReflectionWorkerService } from './reflection.worker';

function fanoutJob(data: ReflectJobData): Job<ReflectJobData> {
  const job = {
    id: 'fanout-1',
    name: REFLECT_JOB_NAMES.fanout,
    data,
    updateData: jest.fn(async (next: ReflectJobData) => {
      job.data = next;
    }),
  };
  return job as unknown as Job<ReflectJobData>;
}

describe('ReflectionWorkerService', () => {
  const gameId = '00000000-0000-4000-8000-000000000001';
  const playerIds = ['player-1', 'player-2'];

  const prisma = {
    player: { findMany: jest.fn() },
  };
  const judge = { backfillRewards: jest.fn(), aggregatePlayerScores: jest.fn() };
  const gameReview = { reviewGame: jest.fn(), loadReview: jest.fn() };
  const reflection = { reflect: jest.fn() };
  const globalMemory = { promotePatterns: jest.fn() };
  const maintenance = { enqueueForGame: jest.fn() };
  const queue = { enqueuePlayers: jest.fn() };

  let worker: ReflectionWorkerService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.player.findMany.mockResolvedValue(playerIds.map((id) => ({ id })));
    judge.backfillRewards.mockResolvedValue(0);
    judge.aggregatePlayerScores.mockResolvedValue(undefined);
    gameReview.reviewGame.mockResolvedValue({});
    gameReview.loadReview.mockResolvedValue(null);
    globalMemory.promotePatterns.mockResolvedValue(0);
    maintenance.enqueueForGame.mockResolvedValue(undefined);
    queue.enqueuePlayers.mockResolvedValue(playerIds.length);

    worker = new ReflectionWorkerService(
      prisma as unknown as PrismaService,
      judge as unknown as JudgeService,
      gameReview as unknown as GameReviewService,
      reflection as unknown as ReflectionService,
      globalMemory as unknown as GlobalMemoryService,
      maintenance as unknown as MemoryMaintenanceService,
      queue as unknown as ReflectionQueueService,
    );
  });

  it('force fanout 在玩家投递失败后重试时复用同一份已落库复盘', async () => {
    const job = fanoutJob({ gameId, force: true, suffix: '_run_1' });
    queue.enqueuePlayers.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(worker.process(job)).rejects.toThrow('redis unavailable');
    expect(job.data.reviewCompleted).toBe(true);

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(gameReview.reviewGame).toHaveBeenCalledTimes(1);
    expect(gameReview.reviewGame).toHaveBeenCalledWith(gameId, true);
    expect(job.updateData).toHaveBeenCalledTimes(1);
    expect(queue.enqueuePlayers).toHaveBeenCalledTimes(2);
  });

  it('judge 重跑后的 reward 刷新失败会重试且不会重做复盘', async () => {
    const job = fanoutJob({
      gameId,
      force: true,
      suffix: '_run_1',
      refreshRewards: true,
    });
    judge.backfillRewards.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(worker.process(job)).rejects.toThrow('db unavailable');
    expect(queue.enqueuePlayers).not.toHaveBeenCalled();

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(gameReview.reviewGame).toHaveBeenCalledTimes(1);
    expect(judge.backfillRewards).toHaveBeenCalledTimes(2);
    expect(queue.enqueuePlayers).toHaveBeenCalledTimes(1);
  });

  it('只跑反思时 reward 补历史空值失败仍继续投递玩家任务', async () => {
    const job = fanoutJob({ gameId });
    judge.backfillRewards.mockRejectedValue(new Error('db unavailable'));

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(queue.enqueuePlayers).toHaveBeenCalledWith(gameId, playerIds, {
      force: undefined,
      suffix: undefined,
    });
  });

  it('complete 分支在全部玩家反思完成后投递记忆维护任务', async () => {
    const job = {
      id: 'complete-1',
      name: REFLECT_JOB_NAMES.complete,
      data: { gameId },
    } as unknown as Job<ReflectJobData>;

    await expect(worker.process(job)).resolves.toBeUndefined();
    expect(maintenance.enqueueForGame).toHaveBeenCalledWith(gameId);
  });
});
