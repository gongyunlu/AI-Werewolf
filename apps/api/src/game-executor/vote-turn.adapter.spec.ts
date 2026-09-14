import { VoteTurnAdapter, assertVoteEventMatches } from './vote-turn.adapter';
import { VoteTurnBindingError } from '@/game-engine/ports/vote-turn.port';
import { buildVoteSchema } from '@/game-engine/nodes/day/vote.node';

const request = {
  gameId: 'g',
  playerId: 'p1',
  seatNo: 1,
  day: 2,
  phase: '普通投票',
  round: 0,
  aliveSeatNos: [1, 2, 3],
  legalSeatNos: [1, 2, 3],
  schema: buildVoteSchema([1, 2, 3]),
};

function setup(decision: unknown) {
  const agentRuntime = {
    prepareContextPublic: jest.fn(async () => ({ id: 'handle' })),
    decide: jest.fn(async () => ({ reasoning: '理由', decision })),
    recordExperienceUsages: jest.fn(async () => {}),
  };
  return { adapter: new VoteTurnAdapter(agentRuntime as never), agentRuntime };
}

const voteEvent = (patch: Record<string, unknown> = {}) => ({
  id: 'e1',
  gameId: 'g',
  actionType: 'vote',
  actorId: 'p1',
  day: 2,
  content: { voteRound: 0, voterSeatNo: 1, targetSeatNo: 2 },
  ...patch,
});

it('把游戏侧请求原样交给上下文准备，不重新推导合法目标', async () => {
  const { adapter, agentRuntime } = setup({ action: 'cast_vote', targetSeatNo: 2 });

  const candidate = await adapter.vote(request);

  expect(agentRuntime.prepareContextPublic).toHaveBeenCalledWith({
    gameId: 'g',
    playerId: 'p1',
    scenario: 'vote',
    actionType: 'vote',
    position: { day: 2, phase: '普通投票', round: 0, aliveSeats: [1, 2, 3] },
    additionalContext: expect.stringContaining('1号、2号、3号'),
  });
  // 理由随候选一并交回节点，最终写进投票事件供观战页展示
  expect(candidate.reasoning).toBe('理由');
  expect(candidate.reference).toMatchObject({
    gameId: 'g',
    playerId: 'p1',
    seatNo: 1,
    day: 2,
    round: 0,
    action: { action: 'cast_vote', targetSeatNo: 2 },
  });
});

it('契约允许不带目标的 cast_vote，按非法输出处理', async () => {
  const { adapter } = setup({ action: 'cast_vote' });
  await expect(adapter.vote(request)).rejects.toMatchObject({ code: 'invalid_output' });
});

it('事件与请求一致时才确认本人记录', async () => {
  const { adapter, agentRuntime } = setup({ action: 'cast_vote', targetSeatNo: 2 });
  const { reference } = await adapter.vote(request);

  await adapter.confirm(reference, voteEvent());

  expect(agentRuntime.recordExperienceUsages).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'handle' }),
    expect.objectContaining({ id: 'e1' }),
  );
});

it.each([
  ['别的玩家', { actorId: 'p2' }],
  ['别的日次', { day: 3 }],
  ['别的轮次', { content: { voteRound: 1, voterSeatNo: 1, targetSeatNo: 2 } }],
  ['别的目标', { content: { voteRound: 0, voterSeatNo: 1, targetSeatNo: 3 } }],
  ['别人的座位', { content: { voteRound: 0, voterSeatNo: 2, targetSeatNo: 2 } }],
  ['别的对局', { gameId: 'other' }],
  ['不是投票事件', { actionType: 'seer_check' }],
])('%s 的事件不能被确认为本人记录', async (_label, patch) => {
  const { adapter, agentRuntime } = setup({ action: 'cast_vote', targetSeatNo: 2 });
  const { reference } = await adapter.vote(request);

  expect(() => assertVoteEventMatches(reference, voteEvent(patch))).toThrow(VoteTurnBindingError);
  await expect(adapter.confirm(reference, voteEvent(patch))).rejects.toBeInstanceOf(
    VoteTurnBindingError,
  );
  expect(agentRuntime.recordExperienceUsages).not.toHaveBeenCalled();
});

it('弃权候选只接受写为零目标的弃票事件', async () => {
  const { adapter } = setup({ action: 'abstain' });
  const { reference } = await adapter.vote(request);

  await expect(
    adapter.confirm(
      reference,
      voteEvent({ content: { voteRound: 0, voterSeatNo: 1, targetSeatNo: 0 } }),
    ),
  ).resolves.toBeUndefined();
  expect(() => assertVoteEventMatches(reference, voteEvent())).toThrow(VoteTurnBindingError);
});

it('动作契约与合法目标由游戏侧提供，adapter 原样使用', async () => {
  const { adapter, agentRuntime } = setup({ action: 'abstain' });
  const schema = buildVoteSchema([9]);

  await adapter.vote({ ...request, legalSeatNos: [9], schema });

  expect(agentRuntime.decide).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'handle' }),
    schema,
    undefined,
  );
  expect(agentRuntime.prepareContextPublic).toHaveBeenCalledWith(
    expect.objectContaining({
      position: expect.objectContaining({ aliveSeats: request.aliveSeatNos }),
      additionalContext: expect.stringContaining('9号'),
    }),
  );
});

it('不是本次执行产生的引用不能被确认', async () => {
  const { adapter, agentRuntime } = setup({ action: 'cast_vote', targetSeatNo: 2 });
  const { reference } = await adapter.vote(request);

  await expect(adapter.confirm({ ...reference }, voteEvent())).rejects.toBeInstanceOf(
    VoteTurnBindingError,
  );
  await expect(adapter.confirm(reference, voteEvent())).resolves.toBeUndefined();
  expect(agentRuntime.recordExperienceUsages).toHaveBeenCalledTimes(1);
});
