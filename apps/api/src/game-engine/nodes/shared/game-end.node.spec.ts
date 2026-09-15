import { createGameState } from '../../testing/test-utils';
import type { NodeContext } from '../node.types';
import { createGameEndNode } from './game-end.node';

describe('createGameEndNode', () => {
  it('先持久化结束事件与终局状态，再唤醒补送，节点不提前关闭 SSE', async () => {
    const calls: string[] = [];
    const gameEndEvent = { id: 'game-end-event' };
    const context = {
      prisma: {
        game: {},
      },
      eventWriter: {
        writeGameEndEvent: jest.fn().mockImplementation(async () => {
          calls.push('persist-terminal-facts');
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

    expect(context.eventWriter.writeGameEndEvent).toHaveBeenCalledWith({
      gameId: 'game-1',
      phaseInstanceId: 'node/0/test',
      signal: undefined,
      winner: 'werewolf',
      winnerFaction: 'werewolf',
      totalDays: 3,
    });
    expect(calls).toEqual(['persist-terminal-facts', 'publish']);
  });

  it('节点不直接广播终局，终局内容交给持久消费者补送', async () => {
    const context = {
      eventWriter: { writeGameEndEvent: jest.fn().mockResolvedValue({ id: 'event-1' }) },
      eventBus: { publish: jest.fn().mockResolvedValue(undefined) },
      broadcaster: { emit: jest.fn(), complete: jest.fn() },
    } as unknown as NodeContext;
    const state = createGameState(
      { gameId: 'game-1', players: [] },
      { currentDay: 3, winner: 'werewolf', isGameOver: true },
    );

    await expect(createGameEndNode(context)(state)).resolves.toEqual({});
    expect(context.eventWriter.writeGameEndEvent).toHaveBeenCalledTimes(1);
    expect(context.broadcaster!.emit).not.toHaveBeenCalled();
  });

  it('终局事务失败时不发布任何派生通知', async () => {
    const context = {
      eventWriter: { writeGameEndEvent: jest.fn().mockRejectedValue(new Error('db unavailable')) },
      eventBus: { publish: jest.fn() },
      broadcaster: { emit: jest.fn(), complete: jest.fn() },
    } as unknown as NodeContext;
    const state = createGameState(
      { gameId: 'game-1', players: [] },
      { currentDay: 3, winner: 'werewolf', isGameOver: true },
    );

    await expect(createGameEndNode(context)(state)).rejects.toThrow('db unavailable');
    expect(context.eventBus!.publish).not.toHaveBeenCalled();
    expect(context.broadcaster!.emit).not.toHaveBeenCalled();
  });
});
