import { ModelCallError } from '@/llm/model-call-guard';
import { VoteNode } from './vote.node';
import { createGameState, createPlayer } from '../../testing/test-utils';
import type { NodeContext } from '../node.types';

describe('VoteNode', () => {
  it('模型失败时写入弃票事件', async () => {
    const agentRuntime = {
      prepareContextPublic: jest.fn().mockResolvedValue({}),
      decide: jest.fn().mockRejectedValue(new ModelCallError('transient')),
    };
    const event = { id: 'vote-event' };
    const context = {
      eventWriter: { writePlayerVoteEvent: jest.fn().mockResolvedValue(event) },
      eventBus: { publish: jest.fn().mockResolvedValue(undefined) },
    } as unknown as NodeContext;
    const node = new VoteNode(agentRuntime as never).create()(context);
    const state = createGameState({
      gameId: 'game-1',
      players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
    });

    await node(state);

    expect(context.eventWriter.writePlayerVoteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'player-1', targetSeatNo: 0 }),
    );
    expect(context.eventBus?.publish).toHaveBeenCalledWith(event);
  });
});
