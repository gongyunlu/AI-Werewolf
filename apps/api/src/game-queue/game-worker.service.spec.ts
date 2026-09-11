import { UnrecoverableError, type Job } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import type { GameJobData } from './game-queue.service';
import { GameWorkerService } from './game-worker.service';
import { PostGameAnalysisError } from '../game-executor/game-executor.exception';
import { ExecutionOwnershipError } from '../game-recovery/game-recovery.service';

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
  const recovery = { interrupt: jest.fn().mockResolvedValue(true) };
  const service = new GameWorkerService(
    gameExecutor as never,
    prisma as never,
    {} as never,
    logger as never,
    broadcaster as never,
    recovery as never,
  );
  const job = {
    id: 'job-1',
    data: { gameId, generation: 3 },
    attemptsMade: 0,
    stalledCounter: 0,
    opts: { attempts: 3 },
  } as Job<GameJobData>;

  return { service, gameExecutor, prisma, broadcaster, recovery, job };
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
      where: expect.objectContaining({ id: gameId, status: GAME_STATUSES.RUNNING }),
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
      expect.objectContaining({
        where: expect.objectContaining({ id: gameId, status: GAME_STATUSES.RUNNING }),
      }),
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

  it('将恢复任务的 generation 交给执行器验证', async () => {
    const { service, gameExecutor, job } = createHarness([GAME_STATUSES.RUNNING]);

    await service.process(job);

    expect(gameExecutor.executeGame).toHaveBeenCalledWith(gameId, 3);
  });

  it('stalled 重领只中断该任务的 generation，不重新运行第一夜', async () => {
    const { service, gameExecutor, recovery, job } = createHarness([GAME_STATUSES.RUNNING]);
    job.stalledCounter = 1;

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(recovery.interrupt).toHaveBeenCalledWith(gameId, 3);
    expect(gameExecutor.executeGame).not.toHaveBeenCalled();
  });

  it('FINISHED 的 stalled 任务仍只补投分析', async () => {
    const { service, gameExecutor, recovery, job } = createHarness([GAME_STATUSES.FINISHED]);
    job.stalledCounter = 1;

    await service.process(job);

    expect(gameExecutor.analyzeFinishedGame).toHaveBeenCalledWith(gameId);
    expect(gameExecutor.executeGame).not.toHaveBeenCalled();
    expect(recovery.interrupt).not.toHaveBeenCalled();
  });

  it.each([undefined, 3])(
    '旧代次 %s 的 stalled 任务不能中断已经恢复的新执行',
    async (generation) => {
      const { service, recovery, job } = createHarness([GAME_STATUSES.RUNNING]);
      job.data.generation = generation;
      let status: string = GAME_STATUSES.RUNNING;
      const currentGeneration = 5;
      recovery.interrupt.mockImplementation(async (_gameId: string, generation?: number) => {
        if (generation !== undefined && generation !== currentGeneration) return false;
        status = GAME_STATUSES.PENDING_RECOVERY;
        return true;
      });
      job.stalledCounter = 1;

      await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(status).toBe(GAME_STATUSES.RUNNING);
    },
  );

  it.each([undefined, 3])('旧代次 %s 的普通错误不能将新执行标记为 ABORTED', async (generation) => {
    const { service, gameExecutor, prisma, broadcaster, job } = createHarness([
      GAME_STATUSES.RUNNING,
    ]);
    job.data.generation = generation;
    let status: string = GAME_STATUSES.RUNNING;
    const currentGeneration = 5;
    prisma.game.updateMany.mockImplementation(
      async ({
        where,
      }: {
        where: { OR?: Array<{ execution: { generation: number } | null }> };
      }) => {
        if (
          where.OR &&
          !where.OR.some((condition) => condition.execution?.generation === currentGeneration)
        )
          return { count: 0 };
        status = GAME_STATUSES.ABORTED;
        return { count: 1 };
      },
    );
    gameExecutor.executeGame.mockRejectedValue(new Error('late model request failed'));

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(status).toBe(GAME_STATUSES.RUNNING);
    expect(broadcaster.emit).not.toHaveBeenCalled();
    expect(broadcaster.complete).not.toHaveBeenCalled();
  });

  it('执行权已转移时旧任务退出，不清理新对局或广播终态', async () => {
    const { service, gameExecutor, prisma, broadcaster, job } = createHarness([
      GAME_STATUSES.RUNNING,
    ]);
    gameExecutor.executeGame.mockRejectedValue(new ExecutionOwnershipError());

    await expect(service.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(prisma.game.updateMany).not.toHaveBeenCalled();
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });
});
