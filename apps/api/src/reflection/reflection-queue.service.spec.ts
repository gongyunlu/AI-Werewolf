import type { Queue } from 'bullmq';
import { REFLECT_JOB_NAMES, ReflectionQueueService } from './reflection-queue.service';

describe('ReflectionQueueService.hasInFlightFanout', () => {
  it('跨 jobId 后缀识别同一对局的在途 fanout', async () => {
    const queue = {
      getJobs: jest.fn().mockResolvedValue([
        { name: REFLECT_JOB_NAMES.player, data: { gameId: 'g1' } },
        { name: REFLECT_JOB_NAMES.fanout, data: { gameId: 'g2', suffix: '_run_1' } },
        { name: REFLECT_JOB_NAMES.fanout, data: { gameId: 'g1', suffix: '_run_2' } },
      ]),
    };
    const service = new ReflectionQueueService(queue as unknown as Queue, {} as never, {} as never);

    await expect(service.hasInFlightFanout('g1')).resolves.toBe(true);
    expect(queue.getJobs).toHaveBeenCalledWith(
      ['active', 'waiting', 'waiting-children', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
  });

  it('fanout 已结束但同局 player job 仍在途时返回 true', async () => {
    const queue = {
      getJobs: jest
        .fn()
        .mockResolvedValue([{ name: REFLECT_JOB_NAMES.player, data: { gameId: 'g1' } }]),
    };
    const service = new ReflectionQueueService(queue as unknown as Queue, {} as never, {} as never);

    await expect(service.hasInFlightFanout('g1')).resolves.toBe(true);
  });

  it('只有其他对局任务时返回 false', async () => {
    const queue = {
      getJobs: jest.fn().mockResolvedValue([
        { name: REFLECT_JOB_NAMES.player, data: { gameId: 'g2' } },
        { name: REFLECT_JOB_NAMES.fanout, data: { gameId: 'g2' } },
      ]),
    };
    const service = new ReflectionQueueService(queue as unknown as Queue, {} as never, {} as never);

    await expect(service.hasInFlightFanout('g1')).resolves.toBe(false);
  });
});

describe('ReflectionQueueService.withGameScheduleLock', () => {
  it('用 Redis NX 锁串行化调度并按 token 释放', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) };
    const service = new ReflectionQueueService({} as never, redis as never, {} as never);

    await expect(service.withGameScheduleLock('g1', async () => 42)).resolves.toEqual({
      acquired: true,
      value: 42,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'analysis:schedule:g1',
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('锁已被占用时不执行调度', async () => {
    const redis = { set: jest.fn().mockResolvedValue(null), eval: jest.fn() };
    const service = new ReflectionQueueService({} as never, redis as never, {} as never);
    const task = jest.fn();

    await expect(service.withGameScheduleLock('g1', task)).resolves.toEqual({ acquired: false });
    expect(task).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('不可逆投递前可主动续租并确认仍持有 token', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) };
    const service = new ReflectionQueueService({} as never, redis as never, {} as never);
    const task = jest.fn(async (lease: { assertOwned(): Promise<void> }) => {
      await lease.assertOwned();
      return 7;
    });

    await expect(service.withGameScheduleLock('g1', task)).resolves.toEqual({
      acquired: true,
      value: 7,
    });
    // 一次 compare-and-pexpire 续租，一次 compare-and-del 释放。
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('续租发现 token 已易主时拒绝继续调度', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(0) };
    const service = new ReflectionQueueService({} as never, redis as never, {} as never);

    await expect(
      service.withGameScheduleLock('g1', async (lease) => {
        await lease.assertOwned();
        throw new Error('不应执行到这里');
      }),
    ).rejects.toThrow('调度锁已丢失');
  });
});

describe('ReflectionQueueService.enqueuePlayers', () => {
  it('把玩家反思建成带失败传播的 completion flow', async () => {
    const flowProducer = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new ReflectionQueueService({} as never, {} as never, flowProducer as never);

    await expect(
      service.enqueuePlayers('g1', ['p1', 'p2'], { force: true, suffix: '_run_1' }),
    ).resolves.toBe(2);

    expect(flowProducer.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: REFLECT_JOB_NAMES.complete,
        data: { gameId: 'g1', suffix: '_run_1' },
        children: [
          expect.objectContaining({
            name: REFLECT_JOB_NAMES.player,
            data: { gameId: 'g1', playerId: 'p1', force: true },
            opts: expect.objectContaining({ failParentOnFailure: true }),
          }),
          expect.objectContaining({
            name: REFLECT_JOB_NAMES.player,
            data: { gameId: 'g1', playerId: 'p2', force: true },
            opts: expect.objectContaining({ failParentOnFailure: true }),
          }),
        ],
      }),
    );
  });
});
