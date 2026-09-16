import { VoteTurnAdapter, buildVoteSchema } from './vote-turn.adapter';
import { assertVoteEventMatches } from '@/game-engine/events/vote-attribution';
import { VoteTurnBindingError } from '@/game-engine/ports/vote-turn.port';
import { isLegalVoteAction, legalVoteActions } from '@/game-engine/rules/ordinary-vote';

const request = {
  gameId: 'g',
  phaseInstanceId: 'node/1/vote',
  playerId: 'p1',
  seatNo: 1,
  day: 2,
  phase: '普通投票',
  round: 0,
  aliveSeatNos: [1, 2, 3],
  legalSeatNos: [1, 2, 3],
  visibleThrough: 12,
};
function setup(decision: unknown) {
  const agentRuntime = {
    prepareContextPublic: jest.fn(async () => ({
      source: {
        actionKey: JSON.stringify(['g', 'node/1/vote', 'vote', 'p1', 0]),
        attemptId: 'attempt',
        traceId: 'trace',
        outputObservationId: 'output',
        startedAt: '2026-09-16T00:00:00Z',
      },
      replay: { scenario: 'vote', evidence: [], reasoning: '理由', decision },
      pendingMemoryUsages: [],
      pendingKnowledgeUsages: [],
      access: { apiKey: '不能持久化的密钥' },
      player: { secret: '不能进入产物的完整玩家上下文' },
    })),
    decide: jest.fn(async () => ({ reasoning: '理由', decision })),
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

it('候选完整序列化，只保留提交所需身份、来源和归因', async () => {
  const { adapter, agentRuntime } = setup({ action: 'cast_vote', targetSeatNo: 2 });
  const candidate = await adapter.vote(request);
  const saved = JSON.parse(JSON.stringify(candidate));
  expect(saved).toEqual(candidate);
  expect(JSON.stringify(saved)).not.toContain('不能');
  expect(saved.reference).toMatchObject({ visibleThrough: 12, phaseInstanceId: 'node/1/vote' });
  expect(() => assertVoteEventMatches(saved.reference, voteEvent())).not.toThrow();
  expect(agentRuntime.prepareContextPublic).toHaveBeenCalledWith(
    expect.objectContaining({
      visibleThrough: 12,
      additionalContext: '你只能投票给以下存活玩家之一：1号、2号、3号，或弃权。',
    }),
  );
});

it.each([
  { action: 'cast_vote' },
  { action: 'cast_vote', targetSeatNo: 9 },
  { action: 'cast_vote', targetSeatNo: 1.5 },
  { action: 'skip' },
])('非法模型动作直接失败：%j', async (decision) => {
  await expect(setup(decision).adapter.vote(request)).rejects.toMatchObject({
    code: 'invalid_output',
  });
});

it('Schema 与核心使用同一合法动作集合，含自投与弃票', () => {
  const schema = buildVoteSchema([1, 3]);
  for (const action of legalVoteActions([1, 3])) {
    expect(schema.safeParse(action).success).toBe(true);
    expect(isLegalVoteAction(action, [1, 3])).toBe(true);
  }
  expect(schema.safeParse({ action: 'cast_vote', targetSeatNo: 2 }).success).toBe(false);
});

it.each([
  ['别的玩家', { actorId: 'p2' }],
  ['别的日次', { day: 3 }],
  ['别的轮次', { content: { voteRound: 1, voterSeatNo: 1, targetSeatNo: 2 } }],
  ['别的目标', { content: { voteRound: 0, voterSeatNo: 1, targetSeatNo: 3 } }],
  ['别人的座位', { content: { voteRound: 0, voterSeatNo: 2, targetSeatNo: 2 } }],
  ['别的对局', { gameId: 'other' }],
  ['不是投票事件', { actionType: 'seer_check' }],
])('%s 不能绑定候选', async (_label, patch) => {
  const { reference } = await setup({ action: 'cast_vote', targetSeatNo: 2 }).adapter.vote(request);
  expect(() => assertVoteEventMatches(reference, voteEvent(patch))).toThrow(VoteTurnBindingError);
});

it('合法弃票明确写成零目标', async () => {
  const { reference } = await setup({ action: 'abstain' }).adapter.vote(request);
  expect(() =>
    assertVoteEventMatches(
      reference,
      voteEvent({ content: { voteRound: 0, voterSeatNo: 1, targetSeatNo: 0 } }),
    ),
  ).not.toThrow();
  expect(() => assertVoteEventMatches(reference, voteEvent())).toThrow(VoteTurnBindingError);
});
