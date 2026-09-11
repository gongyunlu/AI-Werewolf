import { ConflictException } from '@nestjs/common';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GameQueueService, gameJobId } from '../game-queue/game-queue.service';
import { GameResumeService } from './game-resume.service';

const gameId = 'game-1';

function createJob(generation: number, initialState = 'waiting') {
  let status = initialState;
  return {
    id: gameJobId(gameId, generation),
    data: { gameId, generation },
    getState: jest.fn().mockImplementation(async () => status),
    remove: jest.fn(),
    retry: jest.fn().mockImplementation(async () => {
      status = 'waiting';
    }),
  };
}

function createHarness() {
  const state = {
    status: GAME_STATUSES.PENDING_RECOVERY as string,
    generation: 3,
    dispatchPending: false,
  };
  const jobs = new Map<string, ReturnType<typeof createJob>>();
  const previousJob = createJob(2, 'failed');
  jobs.set(previousJob.id, previousJob);
  const executor = { recoveryFingerprintForGame: jest.fn().mockResolvedValue('fingerprint') };
  const bullQueue = {
    getJob: jest.fn().mockImplementation(async (id: string) => jobs.get(id)),
    add: jest
      .fn()
      .mockImplementation(
        async (_name: string, data: { generation: number }, options: { jobId: string }) => {
          if (!jobs.has(options.jobId)) jobs.set(options.jobId, createJob(data.generation));
          return jobs.get(options.jobId)!;
        },
      ),
  };
  const prisma = {
    gameExecution: {
      findUnique: jest.fn().mockImplementation(async () => ({ generation: state.generation })),
    },
  };
  const queue = new GameQueueService(bullQueue as never, prisma as never);
  const recovery = {
    prepareResume: jest.fn().mockImplementation(async () => {
      if (state.status === GAME_STATUSES.RUNNING && state.dispatchPending)
        return { generation: state.generation };
      if (state.status !== GAME_STATUSES.PENDING_RECOVERY)
        throw new ConflictException('already executing');
      state.status = GAME_STATUSES.RUNNING;
      state.dispatchPending = true;
      return { generation: ++state.generation };
    }),
    renewDispatch: jest.fn().mockImplementation(async (_gameId: string, generation: number) => {
      if (state.status !== GAME_STATUSES.RUNNING || !state.dispatchPending)
        throw new ConflictException('already executing');
      if (state.generation === generation) state.generation++;
      return { generation: state.generation };
    }),
  };
  const games = {
    getGameById: jest.fn().mockImplementation(async () => ({ id: gameId, ...state })),
  };
  const service = new GameResumeService(
    executor as never,
    queue,
    recovery as never,
    games as never,
  );
  return { service, executor, bullQueue, queue, recovery, games, previousJob, state, jobs };
}

describe('GameResumeService', () => {
  it('恢复只投递新 generation，保留旧任务供旧执行者正常退出', async () => {
    const { service, executor, recovery, bullQueue, previousJob, jobs } = createHarness();

    await expect(service.resume(gameId)).resolves.toMatchObject({ status: GAME_STATUSES.RUNNING });

    expect(executor.recoveryFingerprintForGame).toHaveBeenCalledWith(gameId);
    expect(recovery.prepareResume).toHaveBeenCalledWith(gameId, 'fingerprint');
    expect(bullQueue.add).toHaveBeenCalledWith(
      'run-game',
      { gameId, generation: 4 },
      expect.objectContaining({ jobId: 'game-1-4' }),
    );
    expect(previousJob.remove).not.toHaveBeenCalled();
    expect(jobs.get('game-1-2')).toBe(previousJob);
  });

  it('两个并发恢复请求只产生一个新 generation 和一个队列任务', async () => {
    const { service, state, jobs, previousJob } = createHarness();

    await Promise.all([service.resume(gameId), service.resume(gameId)]);

    expect(state.generation).toBe(4);
    expect([...jobs.values()].filter((job) => job.data.generation === 4)).toHaveLength(1);
    expect(previousJob.remove).not.toHaveBeenCalled();
  });

  it('检查点或运行版本校验失败时不改变队列', async () => {
    const { service, recovery, bullQueue, previousJob } = createHarness();
    recovery.prepareResume.mockRejectedValue(new ConflictException('incompatible checkpoint'));

    await expect(service.resume(gameId)).rejects.toBeInstanceOf(ConflictException);

    expect(previousJob.remove).not.toHaveBeenCalled();
    expect(bullQueue.add).not.toHaveBeenCalled();
  });

  it('入队明确失败后同接口重试继续投递原 generation', async () => {
    const { service, bullQueue, state, jobs } = createHarness();
    const error = new Error('queue add rejected');
    bullQueue.add.mockRejectedValueOnce(error);

    await expect(service.resume(gameId)).rejects.toBe(error);
    expect(state).toEqual({ status: GAME_STATUSES.RUNNING, generation: 4, dispatchPending: true });
    await expect(service.resume(gameId)).resolves.toMatchObject({ generation: 4 });

    expect(jobs.has('game-1-4')).toBe(true);
    expect(state.generation).toBe(4);
  });

  it('入队成功但响应丢失时重试复用已有任务', async () => {
    const { service, bullQueue, state, jobs } = createHarness();
    const enqueue = bullQueue.add.getMockImplementation()!;
    const error = new Error('queue response lost');
    bullQueue.add.mockImplementationOnce(async (...args) => {
      await enqueue(...args);
      throw error;
    });

    await expect(service.resume(gameId)).rejects.toBe(error);
    const enqueued = jobs.get('game-1-4');
    await expect(service.resume(gameId)).resolves.toMatchObject({ generation: 4 });

    expect(bullQueue.add).toHaveBeenCalledTimes(1);
    expect(jobs.get('game-1-4')).toBe(enqueued);
    expect(state.status).toBe(GAME_STATUSES.RUNNING);
  });

  it('Redis 读取失败后保留投递状态，Redis 恢复时可重试', async () => {
    const { service, bullQueue, state, jobs } = createHarness();
    const error = new Error('redis unavailable');
    bullQueue.getJob.mockRejectedValueOnce(error);

    await expect(service.resume(gameId)).rejects.toBe(error);
    expect(state.dispatchPending).toBe(true);
    await expect(service.resume(gameId)).resolves.toMatchObject({ generation: 4 });

    expect(jobs.has('game-1-4')).toBe(true);
    expect(state.generation).toBe(4);
  });

  it('恢复事务已提交但响应丢失时可继续投递，不再增加 generation', async () => {
    const { service, recovery, state, jobs } = createHarness();
    const prepare = recovery.prepareResume.getMockImplementation()!;
    const error = new Error('commit response lost');
    recovery.prepareResume.mockImplementationOnce(async () => {
      await prepare();
      throw error;
    });

    await expect(service.resume(gameId)).rejects.toBe(error);
    expect(jobs.has('game-1-4')).toBe(false);
    await expect(service.resume(gameId)).resolves.toMatchObject({ generation: 4 });

    expect(state.generation).toBe(4);
    expect(jobs.has('game-1-4')).toBe(true);
  });

  it('执行已真正领取后再次恢复会被拒绝', async () => {
    const { service, state, bullQueue } = createHarness();
    await service.resume(gameId);
    state.dispatchPending = false;

    await expect(service.resume(gameId)).rejects.toBeInstanceOf(ConflictException);

    expect(bullQueue.add).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'waiting', 'delayed', 'paused'])(
    '本次投递任务已为 %s 时不重复添加或重试',
    async (status) => {
      const { service, state, bullQueue, jobs } = createHarness();
      state.status = GAME_STATUSES.RUNNING;
      state.dispatchPending = true;
      const existing = createJob(state.generation, status);
      jobs.set(existing.id, existing);

      await service.resume(gameId);

      expect(bullQueue.add).not.toHaveBeenCalled();
      expect(existing.retry).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'completed'])(
    '本次投递任务 %s 且尚未领取执行权时以新 generation 投递',
    async (status) => {
      const { service, state, bullQueue, jobs, recovery } = createHarness();
      state.status = GAME_STATUSES.RUNNING;
      state.dispatchPending = true;
      const existing = createJob(state.generation, status);
      jobs.set(existing.id, existing);

      await service.resume(gameId);

      expect(recovery.renewDispatch).toHaveBeenCalledWith(gameId, 3);
      expect(bullQueue.add).toHaveBeenCalledWith(
        'run-game',
        { gameId, generation: 4 },
        expect.objectContaining({ jobId: 'game-1-4' }),
      );
      expect(existing.retry).not.toHaveBeenCalled();
      expect(existing.remove).not.toHaveBeenCalled();
      expect(jobs.get(existing.id)).toBe(existing);
    },
  );

  it('并发更换失败投递任务时只产生一个新 generation', async () => {
    const { service, state, jobs, recovery } = createHarness();
    state.status = GAME_STATUSES.RUNNING;
    state.dispatchPending = true;
    const stalled = createJob(3, 'failed');
    jobs.set(stalled.id, stalled);

    await Promise.all([service.resume(gameId), service.resume(gameId)]);

    expect(recovery.renewDispatch).toHaveBeenCalled();
    expect(state.generation).toBe(4);
    expect([...jobs.values()].filter((job) => job.data.generation === 4)).toHaveLength(1);
    expect(stalled.retry).not.toHaveBeenCalled();
  });

  it('第一代任务沿用原 gameId，后续 generation 使用独立 jobId', () => {
    expect(gameJobId(gameId)).toBe(gameId);
    expect(gameJobId(gameId, 1)).toBe(gameId);
    expect(gameJobId(gameId, 4)).toBe('game-1-4');
  });
});
