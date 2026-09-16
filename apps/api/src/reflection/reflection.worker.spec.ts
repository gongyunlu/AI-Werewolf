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
    game: { findUnique: jest.fn() },
    player: { findMany: jest.fn() },
  };
  const judge = { completeEvaluation: jest.fn() };
  const gameReview = { reviewGame: jest.fn(), loadStoredReview: jest.fn() };
  const reflection = { reflect: jest.fn() };
  const globalMemory = { promotePatterns: jest.fn() };
  const maintenance = { enqueueForGame: jest.fn() };
  const queue = { enqueuePlayers: jest.fn() };

  let worker: ReflectionWorkerService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.game.findUnique.mockResolvedValue({ experiment: null });
    prisma.player.findMany.mockResolvedValue(playerIds.map((id) => ({ id })));
    judge.completeEvaluation.mockResolvedValue(undefined);
    gameReview.reviewGame.mockResolvedValue({});
    gameReview.loadStoredReview.mockResolvedValue(null);
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

  it('实验手动分析生成复盘和玩家任务，但不晋升或维护记忆', async () => {
    prisma.game.findUnique.mockResolvedValue({ experiment: { arm: 'on' } });
    gameReview.loadStoredReview.mockResolvedValue({ patterns: [{ title: '不应晋升的规律' }] });
    await worker.process(fanoutJob({ gameId }));
    expect(judge.completeEvaluation).not.toHaveBeenCalled();
    expect(reflection.reflect).not.toHaveBeenCalled();
    expect(gameReview.reviewGame).toHaveBeenCalledWith(gameId, false);
    expect(globalMemory.promotePatterns).not.toHaveBeenCalled();
    expect(maintenance.enqueueForGame).not.toHaveBeenCalled();
    expect(queue.enqueuePlayers).toHaveBeenCalledWith(gameId, playerIds, {
      force: undefined,
      suffix: undefined,
    });
  });

  it('重试复用已落库复盘时照常晋升规律，不因评分运行变化而跳过', async () => {
    const job = fanoutJob({ gameId, reviewCompleted: true });
    gameReview.loadStoredReview.mockResolvedValue({ patterns: [{ title: '晋升的规律' }] });

    await worker.process(job);

    expect(gameReview.reviewGame).not.toHaveBeenCalled();
    expect(globalMemory.promotePatterns).toHaveBeenCalledWith(gameId, [{ title: '晋升的规律' }]);
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

  it('实验玩家反思关闭写回，完成任务不触发记忆维护', async () => {
    prisma.game.findUnique.mockResolvedValue({ experiment: { arm: 'off' } });
    const job = fanoutJob({ gameId, playerId: 'player-1', force: true });
    job.name = REFLECT_JOB_NAMES.player;
    await worker.process(job);
    expect(reflection.reflect).toHaveBeenCalledWith(gameId, 'player-1', true, false);
    job.name = REFLECT_JOB_NAMES.complete;
    await worker.process(job);
    expect(maintenance.enqueueForGame).not.toHaveBeenCalled();
  });

  it('本地评分采用失败时先重试采用，成功后才生成复盘和投递反思', async () => {
    const job = fanoutJob({
      gameId,
      force: true,
      suffix: '_run_1',
      evaluationRunId: 'evaluation-run',
    });
    judge.completeEvaluation.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(worker.process(job)).rejects.toThrow('db unavailable');
    expect(queue.enqueuePlayers).not.toHaveBeenCalled();
    expect(gameReview.reviewGame).not.toHaveBeenCalled();

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(gameReview.reviewGame).toHaveBeenCalledTimes(1);
    expect(judge.completeEvaluation).toHaveBeenCalledTimes(2);
    expect(queue.enqueuePlayers).toHaveBeenCalledTimes(1);
  });

  it('只跑反思复用已有评分，不重复采用或刷新奖励', async () => {
    const job = fanoutJob({ gameId });
    judge.completeEvaluation.mockRejectedValue(new Error('db unavailable'));

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
