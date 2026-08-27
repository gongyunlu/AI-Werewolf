import { GAME_STATUSES } from '@ai-werewolf/shared';
import { createGameState } from '../../testing/test-utils';
import type { NodeContext } from '../node.types';
import { createGameEndNode } from './game-end.node';

describe('createGameEndNode', () => {
  it('先持久化终局状态，再发布结束事件并关闭 SSE', async () => {
    const calls: string[] = [];
    const gameEndEvent = { id: 'game-end-event' };
    const context = {
      prisma: {
        game: {
          update: jest.fn().mockImplementation(async () => {
            calls.push('persist');
          }),
        },
      },
      eventWriter: {
        writeGameEndEvent: jest.fn().mockImplementation(async () => {
          calls.push('write-event');
          return gameEndEvent;
        }),
      },
      eventBus: {
        publish: jest.fn().mockImplementation(async () => {
          calls.push('publish');
        }),
      },
      broadcaster: {
        emit: jest.fn().mockImplementation(() => calls.push('emit')),
        complete: jest.fn().mockImplementation(() => calls.push('complete')),
      },
    } as unknown as NodeContext;
    const state = createGameState(
      { gameId: 'game-1', players: [] },
      { currentDay: 3, winner: 'werewolf', isGameOver: true },
    );

    await createGameEndNode(context)(state);

    expect(context.prisma.game.update).toHaveBeenCalledWith({
      where: { id: 'game-1' },
      data: expect.objectContaining({
        status: GAME_STATUSES.FINISHED,
        winnerFaction: 'werewolf',
        totalDays: 3,
        endedAt: expect.any(Date),
      }),
    });
    expect(calls).toEqual(['persist', 'write-event', 'publish', 'emit', 'complete']);
  });
});
