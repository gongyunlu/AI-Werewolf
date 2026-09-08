import { createCalculateSpeechOrderNode } from './calculate-speech-order.node';
import { createGameState, createPlayer } from '../../testing/test-utils';

it('配对两臂在不同现实分钟执行仍得到相同的时间规则发言顺序', async () => {
  const prisma = {
    ruleset: { findUnique: jest.fn().mockResolvedValue({ definition: {} }) },
    game: {
      findUnique: jest.fn(async ({ where }) => ({
        experiment: {
          version: 1,
          arm: where.id,
          memories: [],
          capturedAt: '2026-09-06T00:01:00.000Z',
        },
      })),
    },
  };
  const eventWriter = { writeSpeechOrderDeterminedEvent: jest.fn().mockResolvedValue({}) };
  const node = createCalculateSpeechOrderNode({ prisma, eventWriter } as never);
  const players = [1, 2, 3, 4, 5, 6].map((seat) => createPlayer(`p${seat}`, seat, true));
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-09-07T00:01:00.000Z'));
    const on = await node(createGameState({ gameId: 'on', players }, { currentDay: 2 }));
    jest.setSystemTime(new Date('2026-09-07T00:02:00.000Z'));
    const off = await node(createGameState({ gameId: 'off', players }, { currentDay: 2 }));
    expect(on).toEqual(off);
    expect(on.speechOrder).toHaveLength(6);
  } finally {
    jest.useRealTimers();
  }
});
