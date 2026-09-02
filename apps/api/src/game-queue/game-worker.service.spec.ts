import { UnrecoverableError, type Job } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import type { GameJobData } from './game-queue.service';
import { GameWorkerService } from './game-worker.service';
import { PostGameAnalysisError } from '../game-executor/game-executor.exception';

const gameId = 'game-1';

function createHarness(statuses: string[]) {
  const gameExecutor = {
    executeGame: jest.fn(),
    analyzeFinishedGame: jest.fn(),
  };
  const prisma = {
    game: {
      findUnique: jest
        .fn()
        .mockImplementation(async () => ({ status: statuses.shift() ?? GAME_STATUSES.RUNNING })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const broadcaster = { emit: jest.fn(), complete: jest.fn() };
  const service = new GameWorkerService(
    gameExecutor as never,
    prisma as never,
    {} as never,
    logger as never,
    broadcaster as never,
  );
  const job = {
    id: 'job-1',
    data: { gameId },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job<GameJobData>;

  return { service, gameExecutor, prisma, broadcaster, job };
}

describe('GameWorkerService', () => {
  it('重试遇到 FINISHED 对局时只补投分析，不重新运行引擎', async () => {
    const { service, gameExecutor, job } = createHarness([GAME_STATUSES.FINISHED]);
    gameExecutor.analyzeFinishedGame.mockResolvedValue(undefined);

    await service.process(job);

    expect(gameExecutor.analyzeFinishedGame).toHaveBeenCalledWith(gameId);
    expect(gameExecutor.executeGame).not.toHaveBeenCalled();
  });

  it('引擎已结束但分析投递失败时保持 FINISHED，并抛错供下一 attempt 重试', async () => {
    const { service, gameExecutor, prisma, broadcaster, job } = createHarness([
      GAME_STATUSES.RUNNING,
    ]);
    const error = new PostGameAnalysisError(gameId, new Error('queue unavailable'));
    gameExecutor.executeGame.mockRejectedValue(error);

    await expect(service.process(job)).rejects.toBe(error);
    expect(prisma.game.updateMany).not.toHaveBeenCalled();
    expect(broadcaster.complete).not.toHaveBeenCalled();
  });

  it('普通引擎失败不可安全重放，立即标记 ABORTED 并终止重试', async () => {
    const { service, gameExecutor, prisma, job } = createHarness([GAME_STATUSES.RUNNING]);
    gameExecutor.executeGame.mockRejectedValue(new Error('engine failed'));

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.game.updateMany).toHaveBeenCalledWith({
      where: { id: gameId, status: GAME_STATUSES.RUNNING },
      data: { status: GAME_STATUSES.ABORTED, endedAt: expect.any(Date) },
    });
  });

  it('引擎错误后的条件清理发现 FINISHED 时只重试赛后分析', async () => {
    const { service, gameExecutor, prisma, broadcaster, job } = createHarness([
      GAME_STATUSES.RUNNING,
      GAME_STATUSES.FINISHED,
    ]);
    gameExecutor.executeGame.mockRejectedValue(new Error('ambiguous commit response'));
    prisma.game.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.process(job)).rejects.toBeInstanceOf(PostGameAnalysisError);

    expect(prisma.game.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: gameId, status: GAME_STATUSES.RUNNING } }),
    );
    expect(broadcaster.emit).not.toHaveBeenCalled();
    expect(broadcaster.complete).not.toHaveBeenCalled();
  });

  it('条件清理未命中且持久化状态不是 FINISHED 时仍禁止重放引擎', async () => {
    const { service, gameExecutor, prisma, job } = createHarness([
      GAME_STATUSES.RUNNING,
      GAME_STATUSES.ABORTED,
    ]);
    gameExecutor.executeGame.mockRejectedValue(new Error('engine failed'));
    prisma.game.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('引擎失败后的状态清理也失败时仍终止重试', async () => {
    const { service, gameExecutor, prisma, job } = createHarness([GAME_STATUSES.RUNNING]);
    gameExecutor.executeGame.mockRejectedValue(new Error('engine failed'));
    prisma.game.updateMany.mockRejectedValue(new Error('db unavailable'));

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
