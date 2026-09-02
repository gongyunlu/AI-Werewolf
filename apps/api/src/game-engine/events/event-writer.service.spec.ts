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
