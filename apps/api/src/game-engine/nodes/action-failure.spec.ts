import { ModelCallError } from '@/llm/model-call-guard';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import { createGameState, createPlayer } from '../testing/test-utils';
import type { NodeContext } from './node.types';
import { VoteNode } from './day/vote.node';
import { PkVoteNode } from './day/pk-vote.node';
import { PkSpeechNode } from './day/pk-speech.node';
import { SpeechNode } from './day/speech.node';
import { LastWordsNode } from './day/last-words.node';
import { SeerCheckNode } from './night/seer-check.node';
import { WitchAntidoteNode } from './night/witch-antidote.node';
import { WitchPoisonNode } from './night/witch-poison.node';
import { WerewolfKillNode } from './night/werewolf-kill.node';
import { wolfVoting } from './night/werewolf-collaboration';
import { resolveNightActions } from '../rules/night-resolution';
import { GameFailurePolicy } from '../core/game-failure-policy';
import { VoteTurnAdapter } from '@/game-executor/vote-turn.adapter';

function setup() {
  const runtime = {
    prepareContextPublic: jest.fn().mockResolvedValue({}),
    decide: jest.fn().mockResolvedValue({ reasoning: 'test', decision: {} }),
    streamSpeech: jest.fn().mockResolvedValue({ thinking: 'test', content: 'speech' }),
    recordExperienceUsages: jest.fn().mockResolvedValue(undefined),
  };
  const eventWriter = Object.fromEntries([
    ...[
      'writeNightPromptEvent',
      'writePlayerVoteEvent',
      'writePlayerSpeechEvent',
      'writeSeerCheckEvent',
      'writeWitchAntidoteEvent',
      'writeWitchPoisonEvent',
      'writeWolfDecisionEvent',
      'writeWolfKillEvent',
    ].map((name) => [name, jest.fn().mockResolvedValue({ id: name })]),
    [
      'writeVoteBatch',
      jest.fn(
        async (batch: { gameId: string; day: number; votes: Array<Record<string, unknown>> }) =>
          batch.votes.map((vote) => ({
            id: 'writeVoteBatch',
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
      ),
    ],
  ]);
  const context = {
    agentRuntime: runtime,
    voteTurn: new VoteTurnAdapter(runtime as never),
    eventWriter,
    prisma: { event: { findMany: jest.fn().mockResolvedValue([]) } },
    eventBus: { publish: jest.fn().mockResolvedValue(undefined) },
    broadcaster: { emit: jest.fn() },
  };
  const state = createGameState(
    {
      gameId: 'g',
      players: [
        createPlayer('p', 1, 'witch', 'villager'),
        createPlayer('q', 2, 'werewolf', 'werewolf'),
      ],
    },
    { wolfTarget: 'q' },
  );
  return { runtime, eventWriter, context, state };
}

it.each([false, true])('PK后续玩家收到准确的完成与跳过列表（首位失败=%s）', async (fails) => {
  const { runtime, context, state } = setup();
  state.pkCandidates = [1, 2];
  state.pkRound = 1;
  if (fails) runtime.streamSpeech.mockRejectedValueOnce(new ModelCallError('transient'));
  await new PkSpeechNode(runtime as never).create()(context as unknown as NodeContext)(state);
  expect(runtime.prepareContextPublic.mock.calls[1][0].position).toMatchObject({
    completedSeats: fails ? [] : [1],
    skippedSeats: fails ? [1] : [],
    order: [1, 2],
  });
});

it.each([false, true])('首夜遗言提供顺序和已完成状态（首位空发言=%s）', async (empty) => {
  const { runtime, eventWriter, context, state } = setup();
  state.players.forEach((player) => {
    player.isAlive = false;
    player.deathDay = 1;
  });
  if (empty) runtime.streamSpeech.mockResolvedValueOnce({ thinking: '无遗言', content: '' });
  await new LastWordsNode(runtime as never).create()(context as unknown as NodeContext)(state);
  expect(runtime.prepareContextPublic.mock.calls[1][0].position).toMatchObject({
    phase: '首夜死亡遗言',
    order: [1, 2],
    completedSeats: empty ? [] : [1],
    skippedSeats: empty ? [1] : [],
  });
  expect(eventWriter.writePlayerSpeechEvent).toHaveBeenCalledTimes(empty ? 1 : 2);
  expect(eventWriter.writePlayerSpeechEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({
      actorId: 'q',
      turn: { phase: '首夜死亡遗言', round: 0 },
    }),
  );
});

it('并发狼刀提案各自持有本人上下文，明确区分提案和讨论', async () => {
  const { runtime, context, state } = setup();
  const wolves = [
    createPlayer('wolf-a', 1, 'werewolf', 'werewolf'),
    createPlayer('wolf-b', 2, 'werewolf', 'werewolf'),
  ];
  state.players = [...wolves, createPlayer('target', 3, 'villager', 'villager')];
  runtime.decide.mockResolvedValue({
    reasoning: '提议刀3号',
    decision: { action: 'propose_kill', targetSeatNo: 3 },
  });
  runtime.prepareContextPublic.mockImplementation(async ({ playerId }) => ({ playerId }));
  const result = await wolfVoting(wolves, state, context as unknown as NodeContext);
  expect(result).toHaveLength(2);
  expect(
    runtime.prepareContextPublic.mock.calls.every(
      (call) => call[0].actionType === 'wolf_proposal' && call[0].position.phase === '狼队刀人提案',
    ),
  ).toBe(true);
  // 每只狼各自拿到自己的上下文，不共用同一个对象。
  expect(
    runtime.decide.mock.calls.map((call) => (call[0] as { playerId: string }).playerId),
  ).toEqual(['wolf-a', 'wolf-b']);
});

describe.each([
  { label: '不存在', targetSeatNo: 99 },
  { label: '已死亡', targetSeatNo: 4 },
])('狼刀目标$label', ({ targetSeatNo }) => {
  it('普通局单狼仅消耗一次降级额度，耗尽后不再落刀', async () => {
    const { runtime, eventWriter, context, state } = setup();
    state.players.push(createPlayer('dead', 4, false));
    runtime.decide.mockResolvedValue({
      reasoning: '提议刀目标玩家',
      decision: { action: 'propose_kill', targetSeatNo },
    });
    const nodeContext = {
      ...context,
      failurePolicy: new GameFailurePolicy(1, false),
    } as unknown as NodeContext;
    const node = new WerewolfKillNode(runtime as never).create()(nodeContext);

    await expect(node(state)).resolves.toEqual({ wolfTarget: 'p' });
    expect(eventWriter.writeWolfDecisionEvent).not.toHaveBeenCalled();
    expect(eventWriter.writeWolfKillEvent).toHaveBeenCalledTimes(1);
    expect(eventWriter.writeWolfKillEvent).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'p', proposalEventIds: [] }),
    );

    await expect(node(state)).rejects.toMatchObject({
      message: expect.stringContaining('降级次数已耗尽 (1/1)'),
      cause: { name: 'ModelCallError', code: 'invalid_output' },
    });
    expect(runtime.decide).toHaveBeenCalledTimes(2);
    expect(eventWriter.writeWolfDecisionEvent).not.toHaveBeenCalled();
    expect(eventWriter.writeWolfKillEvent).toHaveBeenCalledTimes(1);
  });

  it('普通局并发提案保留队友合法投票，非法提案受同一降级预算约束', async () => {
    const { runtime, eventWriter, context, state } = setup();
    const wolves = [state.players[1], createPlayer('teammate', 3, 'werewolf', 'werewolf')];
    state.players.push(wolves[1], createPlayer('dead', 4, false));
    runtime.prepareContextPublic.mockImplementation(async ({ playerId }) => ({ playerId }));
    runtime.decide.mockImplementation(async ({ playerId }: { playerId: string }) => ({
      reasoning: '提议刀目标玩家',
      decision: { action: 'propose_kill', targetSeatNo: playerId === 'q' ? targetSeatNo : 1 },
    }));
    const nodeContext = {
      ...context,
      failurePolicy: new GameFailurePolicy(1, false),
    } as unknown as NodeContext;

    await expect(wolfVoting(wolves, state, nodeContext)).resolves.toEqual([
      expect.objectContaining({ voterId: 'teammate', targetSeatNo: 1 }),
    ]);
    expect(eventWriter.writeWolfDecisionEvent).toHaveBeenCalledTimes(1);

    await expect(wolfVoting(wolves, state, nodeContext)).rejects.toMatchObject({
      message: expect.stringContaining('降级次数已耗尽 (1/1)'),
      cause: { name: 'ModelCallError', code: 'invalid_output' },
    });
    expect(runtime.decide).toHaveBeenCalledTimes(4);
    expect(eventWriter.writeWolfDecisionEvent).toHaveBeenCalledTimes(2);
    for (const [payload] of eventWriter.writeWolfDecisionEvent.mock.calls) {
      expect(payload).toMatchObject({ actorId: 'teammate', content: { targetSeatNo: 1 } });
    }
  });
});

const cases = [
  {
    name: '投票',
    Node: VoteNode,
    writer: 'writeVoteBatch',
    action: 'cast_vote',
    role: 'villager',
  },
  {
    name: 'PK',
    Node: PkVoteNode,
    writer: 'writePlayerVoteEvent',
    action: 'cast_vote',
    role: 'villager',
  },
  {
    name: '查验',
    Node: SeerCheckNode,
    writer: 'writeSeerCheckEvent',
    action: 'check_identity',
    role: 'seer',
  },
  {
    name: '解药',
    Node: WitchAntidoteNode,
    writer: 'writeWitchAntidoteEvent',
    action: 'antidote',
    role: 'witch',
  },
  {
    name: '毒药',
    Node: WitchPoisonNode,
    writer: 'writeWitchPoisonEvent',
    action: 'poison',
    role: 'witch',
  },
  {
    name: '发言',
    Node: SpeechNode,
    writer: 'writePlayerSpeechEvent',
    action: '',
    role: 'villager',
  },
  {
    name: '狼刀提案',
    Node: WerewolfKillNode,
    writer: 'writeWolfDecisionEvent',
    action: 'propose_kill',
    role: 'werewolf',
  },
] as const;

describe.each(cases)('$name 的提交边界', ({ Node, writer, action, role }) => {
  it.each(['commit', 'usage', 'publish'] as const)('%s 失败不会再提交替代动作', async (failure) => {
    const { runtime, eventWriter, context, state } = setup();
    state.players[0].role = role;
    if (Node === VoteNode || Node === SpeechNode) state.players = [state.players[0]];
    if (Node === PkVoteNode) state.pkCandidates = [2];
    if (Node === WerewolfKillNode) state.players[1].role = 'villager';
    const targetSeatNo = state.players.length === 1 ? 1 : 2;
    runtime.decide.mockResolvedValue({ reasoning: 'test', decision: { action, targetSeatNo } });
    // 故意模拟下游也抛出模型错误类型，确保外层 catch 不会误选 gameplay fallback。
    const error = new ModelCallError('transient');
    if (failure === 'commit') eventWriter[writer].mockRejectedValue(error);
    if (failure === 'usage') runtime.recordExperienceUsages.mockRejectedValue(error);
    if (failure === 'publish') {
      if (Node === WerewolfKillNode)
        eventWriter.writeWolfKillEvent.mockRejectedValue(new Error('lost commit response'));
      else if (Node === SpeechNode)
        context.broadcaster.emit.mockImplementation((_gameId, event) => {
          if (event.type === 'scene.close') throw error;
        });
      else
        context.eventBus.publish.mockImplementation(async (event) => {
          if (event.id === writer) throw error;
        });
    }
    await expect(
      new Node(runtime as never).create()(context as unknown as NodeContext)(state),
    ).rejects.toThrow();
    expect(eventWriter[writer]).toHaveBeenCalledTimes(1);
    expect(runtime.decide).toHaveBeenCalledTimes(Node === SpeechNode ? 0 : 1);
    if (Node === WerewolfKillNode)
      expect(eventWriter.writeWolfKillEvent).toHaveBeenCalledTimes(failure === 'publish' ? 1 : 0);
  });
});

it.each([new TypeError('context bug'), new ExperimentInvalidError('snapshot missing')])(
  '准备失败保持原异常且不写票：%s',
  async (error) => {
    const { runtime, eventWriter, context, state } = setup();
    state.players = [state.players[0]];
    runtime.prepareContextPublic.mockRejectedValue(error);
    await expect(new VoteNode().create()(context as unknown as NodeContext)(state)).rejects.toBe(
      error,
    );
    expect(eventWriter.writeVoteBatch).not.toHaveBeenCalled();
  },
);

it.each([false, true])('PK 调用失败不随机放逐，也不补弃权票（部分失败=%s）', async (partial) => {
  const { runtime, eventWriter, context, state } = setup();
  state.players.push(createPlayer('r', 3, 'villager', 'villager'));
  state.pkCandidates = [2];
  runtime.decide.mockRejectedValue(new ModelCallError('circuit_open'));
  if (partial)
    runtime.decide.mockResolvedValueOnce({ reasoning: 'test', decision: { targetSeatNo: 2 } });
  await expect(
    new PkVoteNode(runtime as never).create()(context as unknown as NodeContext)(state),
  ).rejects.toBeInstanceOf(ModelCallError);
  expect(eventWriter.writePlayerVoteEvent).toHaveBeenCalledTimes(partial ? 1 : 0);
  for (const [payload] of eventWriter.writePlayerVoteEvent.mock.calls)
    expect(payload.targetSeatNo).toBe(2);
});

it.each(['antidote', 'poison'] as const)('先使用 %s 后，同晚不能使用另一瓶药', async (first) => {
  const { runtime, eventWriter, context, state } = setup();
  runtime.decide.mockResolvedValue({
    reasoning: 'test',
    decision: { action: first, targetSeatNo: 2 },
  });
  const save = new WitchAntidoteNode(runtime as never).create()(context as unknown as NodeContext);
  const poison = new WitchPoisonNode(runtime as never).create()(context as unknown as NodeContext);
  const update = await (first === 'antidote' ? save : poison)(state);
  await (first === 'antidote' ? poison : save)({ ...state, ...update });
  expect(runtime.decide).toHaveBeenCalledTimes(1);
  expect(eventWriter.writeWitchAntidoteEvent).toHaveBeenCalledTimes(first === 'antidote' ? 1 : 0);
  expect(eventWriter.writeWitchPoisonEvent).toHaveBeenCalledTimes(first === 'poison' ? 1 : 0);
});

it('首夜救人后，后续夜晚可合法毒同一目标并完成结算', async () => {
  const { runtime, eventWriter, context, state } = setup();
  runtime.decide.mockResolvedValueOnce({
    reasoning: '首夜救2号',
    decision: { action: 'antidote', targetSeatNo: 2 },
  });
  const saved = await new WitchAntidoteNode(runtime as never).create()(
    context as unknown as NodeContext,
  )(state);
  const nextNight = { ...state, ...saved, currentDay: 2, witchAntidoteTarget: null };
  runtime.decide.mockResolvedValueOnce({
    reasoning: '第二夜重新判断2号为狼，使用毒药',
    decision: { action: 'poison', targetSeatNo: 2 },
  });
  const poisoned = await new WitchPoisonNode(runtime as never).create()(
    context as unknown as NodeContext,
  )(nextNight);
  expect(eventWriter.writeWitchPoisonEvent).toHaveBeenCalledWith(
    expect.objectContaining({ day: 2, targetId: 'q', targetSeatNo: 2 }),
  );
  expect(
    resolveNightActions({
      players: poisoned.players!,
      wolfTarget: null,
      guardTarget: null,
      witchAntidoteTarget: null,
      witchPoisonTarget: poisoned.witchPoisonTarget!,
    }).deaths,
  ).toEqual([{ playerId: 'q', cause: 'witch_poison' }]);
});
