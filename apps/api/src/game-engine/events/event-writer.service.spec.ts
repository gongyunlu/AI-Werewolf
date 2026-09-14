import { ACTION_TYPES, GAME_STATUSES } from '@ai-werewolf/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import { EventWriterService } from './event-writer.service';

describe('EventWriterService.writeGameEndEvent', () => {
  const params = {
    gameId: '00000000-0000-4000-8000-000000000001',
    winner: 'werewolf',
    winnerFaction: 'werewolf',
    totalDays: 3,
    endedAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  function createHarness() {
    const event = { id: 'event-1', gameId: params.gameId, sequence: 7 };
    const tx = {
      event: { create: jest.fn().mockResolvedValue(event) },
      game: { update: jest.fn().mockResolvedValue(undefined) },
    };
    const prisma = {
      $transaction: jest.fn(async (task: (client: typeof tx) => Promise<unknown>) => task(tx)),
      event: { findFirst: jest.fn() },
    };
    const redis = {
      incr: jest.fn().mockResolvedValue(7),
      set: jest.fn(),
    };
    const service = new EventWriterService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    return { service, prisma, redis, tx, event };
  }

  it('在同一个 Prisma transaction 内写 GAME_ENDED 与 FINISHED', async () => {
    const { service, prisma, tx, event } = createHarness();

    await expect(service.writeGameEndEvent(params)).resolves.toBe(event);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gameId: params.gameId,
        sequence: 7,
        actionType: ACTION_TYPES.GAME_ENDED,
        content: { winner: 'werewolf' },
      }),
    });
    expect(tx.game.update).toHaveBeenCalledWith({
      where: { id: params.gameId },
      data: {
        status: GAME_STATUSES.FINISHED,
        winnerFaction: 'werewolf',
        totalDays: 3,
        endedAt: params.endedAt,
      },
    });
  });

  it('sequence 冲突时先让整笔事务回滚，再重建计数器重试整笔终局写入', async () => {
    const { service, prisma, redis, tx, event } = createHarness();
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementationOnce(async (task: (client: typeof tx) => Promise<unknown>) => task(tx));
    prisma.event.findFirst.mockResolvedValue({ sequence: 9 });
    redis.incr.mockResolvedValueOnce(7).mockResolvedValueOnce(10);

    await expect(service.writeGameEndEvent(params)).resolves.toBe(event);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith(`game:${params.gameId}:event_seq`, 9);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sequence: 10 }),
    });
  });
});

describe('EventWriterService.writeVoteBatch', () => {
  function createHarness() {
    const tx = {
      event: {
        create: jest.fn(
          async ({ data }: { data: { sequence: number; content: Record<string, unknown> } }) => ({
            id: `event-${data.sequence}`,
            sequence: data.sequence,
          }),
        ),
      },
      findFirst: jest.fn(),
    };
    const prisma = {
      $transaction: jest.fn(async (task: (client: typeof tx) => Promise<unknown>) => task(tx)),
      event: { findFirst: jest.fn() },
    };
    const redis = { incrby: jest.fn().mockResolvedValue(12), set: jest.fn() };
    const service = new EventWriterService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    return { service, prisma, tx, redis };
  }

  it('整批投票在同一个 Prisma transaction 内按连续序号写入', async () => {
    const { service, prisma, tx, redis } = createHarness();

    const events = await service.writeVoteBatch({
      gameId: 'g',
      day: 1,
      votes: [
        { actorId: 'p1', voterSeatNo: 1, targetSeatNo: 2 },
        { actorId: 'p2', voterSeatNo: 2, targetSeatNo: 0 },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(redis.incrby).toHaveBeenCalledWith('game:g:event_seq', 2);
    expect(tx.event.create.mock.calls.map(([args]) => args.data.sequence)).toEqual([11, 12]);
    expect(tx.event.create.mock.calls.map(([args]) => args.data.content)).toEqual([
      { voteRound: 0, voterSeatNo: 1, targetSeatNo: 2 },
      { voteRound: 0, voterSeatNo: 2, targetSeatNo: 0 },
    ]);
    expect(events.map((event) => event.id)).toEqual(['event-11', 'event-12']);
  });

  it('批内任一条写入失败时整批失败', async () => {
    const { service, tx, prisma } = createHarness();
    tx.event.create
      .mockResolvedValueOnce({ id: 'event-11', sequence: 11 })
      .mockRejectedValueOnce(new Error('批内第二条写入失败'));

    await expect(
      service.writeVoteBatch({
        gameId: 'g',
        day: 1,
        votes: [
          { actorId: 'p1', voterSeatNo: 1, targetSeatNo: 2 },
          { actorId: 'p2', voterSeatNo: 2, targetSeatNo: 1 },
        ],
      }),
    ).rejects.toThrow('批内第二条写入失败');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('序号冲突时先让整批回滚，再重建计数器重试整批', async () => {
    const { service, prisma, tx, redis } = createHarness();
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementationOnce(async (task: (client: typeof tx) => Promise<unknown>) => task(tx));
    prisma.event.findFirst.mockResolvedValue({ sequence: 9 });
    redis.incrby.mockResolvedValueOnce(12).mockResolvedValueOnce(15);

    const events = await service.writeVoteBatch({
      gameId: 'g',
      day: 1,
      votes: [
        { actorId: 'p1', voterSeatNo: 1, targetSeatNo: 2 },
        { actorId: 'p2', voterSeatNo: 2, targetSeatNo: 0 },
        { actorId: 'p3', voterSeatNo: 3, targetSeatNo: 1 },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledWith('game:g:event_seq', 9);
    expect(events.map((event) => event.sequence)).toEqual([13, 14, 15]);
  });

  it('没有投票时不开启事务', async () => {
    const { service, prisma, redis } = createHarness();

    await expect(service.writeVoteBatch({ gameId: 'g', day: 1, votes: [] })).resolves.toEqual([]);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });
});

describe('EventWriterService.writeJudgeEvent', () => {
  function createHarness() {
    const event = { id: 'event-1' };
    const calls: string[] = [];
    const createEvent = jest.fn(async () => {
      calls.push('event');
      return event;
    });
    const tx = {
      event: { create: createEvent },
      player: {
        update: jest.fn(async () => {
          calls.push('player');
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (task: (client: typeof tx) => Promise<unknown>) => task(tx)),
      event: { create: createEvent, findFirst: jest.fn() },
    };
    const service = new EventWriterService(
      prisma as unknown as PrismaService,
      { incr: jest.fn().mockResolvedValue(3), set: jest.fn() } as unknown as RedisService,
    );
    return { service, prisma, tx, calls };
  }

  it('播报与它宣告的状态变更在同一个 Prisma transaction 内提交', async () => {
    const { service, prisma, tx, calls } = createHarness();

    await service.writeJudgeEvent({
      gameId: 'g',
      day: 1,
      content: '1号位狼人自爆，进入黑夜。',
      updateState: async (client) => {
        await client.player.update({ where: { id: 'p' }, data: { deathDay: 1 } });
      },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actionType: ACTION_TYPES.JUDGE_ANNOUNCE }),
    });
    expect(calls).toEqual(['event', 'player']);
  });

  it('状态变更失败时播报写入一并失败，不留下半个效果', async () => {
    const { service, tx } = createHarness();
    tx.player.update.mockRejectedValue(new Error('状态写入失败'));

    await expect(
      service.writeJudgeEvent({
        gameId: 'g',
        day: 1,
        content: '1号位狼人自爆，进入黑夜。',
        updateState: async (client) => {
          await client.player.update({ where: { id: 'p' }, data: { deathDay: 1 } });
        },
      }),
    ).rejects.toThrow('状态写入失败');
  });

  it('没有状态变更时按单条事件写入', async () => {
    const { service, prisma, calls } = createHarness();

    await service.writeJudgeEvent({ gameId: 'g', day: 1, content: '天亮了' });

    expect(calls).toEqual(['event']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
