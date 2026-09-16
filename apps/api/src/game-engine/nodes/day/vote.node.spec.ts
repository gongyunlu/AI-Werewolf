import { ModelCallError } from '@/llm/model-call-guard';
import { VoteNode } from './vote.node';
import { VoteTurnAdapter } from '@/game-executor/vote-turn.adapter';
import { createGameState, createPlayer } from '../../testing/test-utils';
import type { NodeContext } from '../node.types';

function setup(decide: jest.Mock) {
  const agentRuntime = {
    prepareContextPublic: jest.fn().mockResolvedValue({
      id: 'handle',
      source: { actionKey: 'key' },
      replay: { scenario: 'vote' },
      pendingMemoryUsages: [],
      pendingKnowledgeUsages: [],
    }),
    voteVisibleThrough: jest.fn().mockResolvedValue(0),
    decide,
    recordExperienceUsages: jest.fn().mockResolvedValue(undefined),
  };
  const writeVoteBatch = jest.fn(
    async (batch: { gameId: string; day: number; votes: Array<Record<string, unknown>> }) =>
      batch.votes.map((vote, index) => ({
        id: `vote-event-${index}`,
        gameId: batch.gameId,
        actionType: 'vote',
        actorId: vote.actorId,
        day: batch.day,
        content: {
          voteRound: 0,
          voterSeatNo: vote.voterSeatNo,
          targetSeatNo: vote.targetSeatNo,
        },
      })),
  );
  const context = {
    voteTurn: new VoteTurnAdapter(agentRuntime as never),
    eventWriter: { writeVoteBatch },
    eventBus: { publish: jest.fn().mockResolvedValue(undefined) },
  } as unknown as NodeContext;
  const state = createGameState({
    gameId: 'game-1',
    players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
  });
  return { context, state, agentRuntime, writeVoteBatch };
}

describe('VoteNode', () => {
  it('照常投票时将完整产物交给批次事务，提交后直接发布', async () => {
    const { context, state, agentRuntime, writeVoteBatch } = setup(
      jest.fn().mockResolvedValue({
        reasoning: '归票自己',
        decision: { action: 'cast_vote', targetSeatNo: 1 },
      }),
    );

    await expect(new VoteNode().create()(context)(state)).resolves.toEqual({
      exileTarget: 'player-1',
      exileVoteCount: 1,
    });

    expect(writeVoteBatch).toHaveBeenCalledTimes(1);
    expect(writeVoteBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId: 'game-1',
        phaseInstanceId: 'node/0/test',
        signal: undefined,
        day: 1,
        expectedActorIds: ['player-1'],
        sources: { 'player-1': { actionKey: 'key' } },
        turns: [expect.objectContaining({ attribution: expect.any(Object) })],
        votes: [{ actorId: 'player-1', voterSeatNo: 1, targetSeatNo: 1, thinking: '归票自己' }],
      }),
    );
    expect(agentRuntime.recordExperienceUsages).not.toHaveBeenCalled();
    expect(context.eventBus?.publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vote-event-0' }),
    );
  });

  it('模型失败时整轮中止，不改写为弃票', async () => {
    const { context, state, agentRuntime, writeVoteBatch } = setup(
      jest.fn().mockRejectedValue(new ModelCallError('transient')),
    );

    await expect(new VoteNode().create()(context)(state)).rejects.toMatchObject({
      name: 'ModelCallError',
      code: 'transient',
    });

    expect(writeVoteBatch).not.toHaveBeenCalled();
    expect(agentRuntime.recordExperienceUsages).not.toHaveBeenCalled();
    expect(context.eventBus?.publish).not.toHaveBeenCalled();
  });

  it('事务内绑定失败时不广播，也不补写第二张票', async () => {
    const { context, state, writeVoteBatch } = setup(
      jest.fn().mockResolvedValue({
        reasoning: '投自己',
        decision: { action: 'cast_vote', targetSeatNo: 1 },
      }),
    );
    // 事件写出的目标与本次动作不符，属于绑定错误，不能降级成第二张弃票。
    writeVoteBatch.mockRejectedValueOnce(new Error('投票事件与本次请求不符'));

    await expect(new VoteNode().create()(context)(state)).rejects.toThrow('投票事件与本次请求不符');
    expect(writeVoteBatch).toHaveBeenCalledTimes(1);
    expect(context.eventBus?.publish).not.toHaveBeenCalled();
  });
});
