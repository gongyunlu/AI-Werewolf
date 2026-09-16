import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { PromptService } from '../observability/prompt.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

/** 决策前的思考轮是普通流式调用，这里只要求它产出一段非空思考。 */
const thinkingStream = async () =>
  (async function* () {
    yield new AIMessage('核对可见事实后行动。');
  })();

function createRuntime(
  invoke: jest.Mock,
  events: unknown[] = [],
  options: {
    role?: string;
    deathDay?: number;
    readPersonalJudgments?: jest.Mock;
    decisionContext?: jest.Mock;
  } = {},
) {
  jest
    .mocked(ChatOpenAI)
    .mockImplementation(
      () => ({ withStructuredOutput: () => ({ invoke }), stream: thinkingStream }) as never,
    );
  const config = {
    get: jest.fn((key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 0 : undefined)),
  };
  const game = { id: 'g', rulesetId: 'standard6p', skillVersion: 'v1', experiment: null };
  const player = {
    id: 'p',
    agentId: 'a',
    gameId: 'g',
    game,
    role: options.role ?? 'villager',
    faction: options.role === 'werewolf' ? 'werewolf' : 'villager',
    seatNo: 1,
    displayName: '阿四',
    modelName: 'test',
    deathDay: options.deathDay ?? null,
    memoryLabelSnapshot: 'default',
  };
  const prompts = new PromptService(config as never);
  const runtime = createAgentRuntime(
    ...([
      config,
      {
        player: {
          findUnique: jest.fn().mockResolvedValue(player),
          findMany: jest.fn().mockImplementation(async ({ where }) =>
            [
              { id: 'p2', agentId: 'a2', seatNo: 2, displayName: '阿三', role: 'seer' },
              { id: 'p3', agentId: 'a3', seatNo: 3, displayName: '阿五', role: 'witch' },
              { id: 'p4', agentId: 'a4', seatNo: 4, displayName: '阿七', role: 'villager' },
              { id: 'p5', agentId: 'a5', seatNo: 5, displayName: '阿六', role: 'villager' },
              { id: 'p6', agentId: 'a6', seatNo: 6, displayName: '阿八', role: 'werewolf' },
            ].filter((other) => !where.role || other.role === where.role),
          ),
        },
        event: {
          findMany: jest.fn().mockResolvedValue(events),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        decisionContext: {
          findMany: options.decisionContext ?? jest.fn().mockResolvedValue([]),
        },
      },
      {
        retrieveActiveMemories: jest.fn().mockResolvedValue([]),
        retrieveExperience: jest.fn().mockResolvedValue({ lessons: [], playerModels: [] }),
      },
      { retrieveActivePatterns: jest.fn().mockResolvedValue([]) },
      {},
      new SkillLoaderService(config as never),
      {
        readPersonalJudgments:
          options.readPersonalJudgments ??
          jest.fn().mockResolvedValue({
            recentSpeeches: [],
            olderSpeechesSummary: [],
            recentJudgments: [],
            olderJudgmentsSummary: [],
          }),
      },
      { trace: jest.fn().mockReturnValue({ callbacks: [] }) },
      prompts,
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  return runtime;
}

it.each(['werewolf', 'seer', 'witch', 'villager'])(
  '%s 的真实 Prompt 提供本局完整公开名册，姓名不按字面数字推断座位',
  async (role) => {
    const runtime = createRuntime(jest.fn(), [], { role });
    const context = await runtime.prepareContextPublic({
      gameId: 'g',
      playerId: 'p',
      scenario: 'night_action',
      actionType: 'speech',
      position: { day: 1, phase: '夜间', round: 1, aliveSeats: [1, 2, 3, 4, 6] },
    });
    const roster =
      '本局公开座位与姓名：1号（阿四）、2号（阿三）、3号（阿五）、4号（阿七）、5号（阿六）、6号（阿八）';
    expect(context.systemPrompt).toContain(roster);
    expect(context.replay?.turnContext).toContain(roster);
    expect(context.replay?.turnContext).not.toMatch(/werewolf|seer|witch|villager/);
    expect(context.replay?.turnContext).not.toContain('3号（阿三）');
  },
);

it('普通投票上下文包含实际使用的动作模板，并能完成结构化决策', async () => {
  const invoke = jest.fn().mockResolvedValue({
    raw: new AIMessage(
      JSON.stringify({ reasoning: '当前信息不足，弃票。', decision: { action: 'abstain' } }),
    ),
    parsed: { reasoning: '当前信息不足，弃票。', decision: { action: 'abstain' } },
  });
  const runtime = createRuntime(invoke);
  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'vote',
    actionType: 'vote',
    position: { day: 1, phase: 'vote', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
  });
  expect(context.prompts?.[PROMPT_NAMES.agentActionSystem]).toBeDefined();
  await expect(
    runtime.decide(context, z.object({ action: z.literal('abstain') })),
  ).resolves.toMatchObject({ decision: { action: 'abstain' } });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(context.systemPrompt).toContain('绑票');
});

it.each([401, 503])('供应商返回 %s 时遵守统一调用次数', async (status) => {
  const invoke = jest
    .fn()
    .mockRejectedValue(Object.assign(new Error('provider failure'), { status }));
  const runtime = createRuntime(invoke);
  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'vote',
    actionType: 'vote',
    position: { day: 1, phase: 'vote', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
  });
  await expect(
    runtime.decide(context, z.object({ action: z.literal('abstain') })),
  ).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(status === 401 ? 1 : 2);
  expect(ChatOpenAI).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: 0 }));
});

it('真实 Prompt 组装保留自己普通发言原文与 PK 的明确位置', async () => {
  const runtime = createRuntime(jest.fn(), [
    {
      id: 'e30',
      sequence: 30,
      gameId: 'g',
      actorId: 'p',
      day: 2,
      actionType: 'speech',
      visibility: 'public',
      content: { seatNo: 1, speech: '首夜验4号金水，昨夜验6号查杀' },
    },
  ]);
  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'day_speech',
    actionType: 'speech',
    position: {
      aliveSeats: [1, 2, 3, 4, 5, 6],
      day: 2,
      phase: 'PK发言',
      round: 1,
      order: [1, 6],
      completedSeats: [],
    },
  });
  expect(context.systemPrompt).toContain('你本人1号发言原文：首夜验4号金水');
  expect(context.systemPrompt).toContain('阶段：PK发言');
  expect(context.systemPrompt).toContain('你之后尚未轮到：6');
  expect(context.replay?.position).toMatchObject({ round: 1, phase: 'PK发言' });
});

it('当前日次、检索和判断窗口均采用引擎时点，旧原文只出现一次', async () => {
  const readPersonalJudgments = jest
    .fn()
    .mockResolvedValue({ recentJudgments: [], olderJudgmentsSummary: [] });
  const runtime = createRuntime(
    jest.fn(),
    [
      {
        sequence: 7,
        day: 1,
        phase: 'speech',
        actorId: 'p',
        actionType: 'speech',
        visibility: 'public',
        content: {
          seatNo: 1,
          speech: '我暂时保留意见，等后面发言。',
          thinking: '本人当时保留意见的判断',
        },
      },
    ],
    { readPersonalJudgments },
  );
  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'vote',
    actionType: 'vote',
    position: { day: 2, phase: '普通投票', round: 0, aliveSeats: [1, 3, 5] },
  });
  expect(context.systemPrompt).toContain('当前第2天');
  expect(context.systemPrompt).toContain('存活玩家：1、3、5');
  expect(context.systemPrompt.match(/我暂时保留意见，等后面发言。/g)).toHaveLength(1);
  // 本人的旧理由按事件补进上下文，且只出现一次
  expect(context.systemPrompt.match(/\[你的私有理由·当时\] 本人当时保留意见的判断/g)).toHaveLength(
    1,
  );
  expect(context.replay?.query).toContain('第2天投票');
  expect(readPersonalJudgments).toHaveBeenCalledWith('g', 2, 'a');
});

it.each(['villager', 'seer', 'witch', 'werewolf'])(
  '%s 只获得累计授权记录，跨夜狼聊完整保留',
  async (role) => {
    const records = [
      {
        sequence: 1,
        day: 1,
        phase: 'night',
        actorId: 'p',
        actionType: 'speech',
        visibility: 'wolf',
        content: { seatNo: 1, round: 1, speech: '明天我悍跳你倒钩', thinking: '狼队私有推理' },
      },
      {
        sequence: 2,
        day: 1,
        phase: 'night',
        actorId: 'wolf',
        actionType: 'wolf_kill',
        visibility: 'wolf_kill',
        content: { targetSeatNo: 5 },
      },
      {
        sequence: 3,
        day: 1,
        phase: 'night',
        actorId: 'p',
        actionType: 'witch_save',
        visibility: 'witch',
        content: { saved: false },
      },
      {
        sequence: 4,
        day: 1,
        phase: 'night',
        actorId: 'p',
        actionType: 'seer_check',
        visibility: 'seer',
        content: { targetSeatNo: 6, result: 'good' },
      },
      {
        sequence: 5,
        day: 2,
        phase: 'night',
        actorId: 'wolf',
        actionType: 'wolf_kill',
        visibility: 'wolf_kill',
        content: { targetSeatNo: 6 },
      },
      {
        sequence: 6,
        day: 2,
        phase: 'night',
        actorId: 'p',
        actionType: 'witch_save',
        visibility: 'witch',
        content: { saved: true, targetSeatNo: 6 },
      },
      {
        sequence: 7,
        day: 3,
        phase: 'night',
        actorId: 'wolf',
        actionType: 'wolf_kill',
        visibility: 'wolf_kill',
        content: { targetSeatNo: 3 },
      },
    ];
    const runtime = createRuntime(jest.fn(), records, { role });
    const context = await runtime.prepareContextPublic({
      gameId: 'g',
      playerId: 'p',
      scenario: 'night_action',
      actionType: 'speech',
      position: { day: 3, phase: '夜间行动', round: 1, aliveSeats: [1, 2, 3, 6] },
    });
    const ids = (context.replay!.evidence as Array<{ sequence: number }>).map((e) => e.sequence);
    expect(ids).toEqual(
      { villager: [], seer: [4], witch: [2, 3, 5, 6], werewolf: [1, 2, 5, 7] }[role],
    );
    expect(context.systemPrompt.includes('明天我悍跳你倒钩')).toBe(role === 'werewolf');
    // 本人（1号）当时的私有理由随事件补入；被可见性过滤掉的角色看不到该事件
    expect(context.systemPrompt.includes('狼队私有推理')).toBe(role === 'werewolf');
    if (role === 'werewolf') expect(context.systemPrompt).toContain('你本人1号发言原文（第1轮）');
    if (role === 'witch') {
      expect(context.systemPrompt).toContain('狼刀目标：5号');
      expect(context.systemPrompt).not.toContain('狼刀目标：3号');
    }
    expect(context.systemPrompt).toContain('女巫任何夜晚都不能自救');
    expect(context.systemPrompt).toContain('可以在后续夜晚毒此前用解药救过的目标');
  },
);

it('只补入本人的旧理由，同桌他人的 thinking 不进入上下文', async () => {
  const runtime = createRuntime(jest.fn(), [
    {
      sequence: 11,
      day: 1,
      phase: 'speech',
      actorId: 'p2',
      actionType: 'speech',
      visibility: 'public',
      content: { seatNo: 2, speech: '我觉得1号发言有问题', thinking: '他人的私密判断' },
    },
    {
      sequence: 12,
      day: 1,
      phase: 'vote',
      actorId: 'p',
      actionType: 'vote',
      visibility: 'public',
      content: { voterSeatNo: 1, targetSeatNo: 2, voteRound: 0 },
    },
  ]);
  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'day_speech',
    actionType: 'speech',
    position: { day: 2, phase: '普通发言', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
  });
  expect(context.systemPrompt).toContain('你本人已提交：第0轮投票：1号投给2号');
  expect(context.systemPrompt).toContain('2号发言原文：我觉得1号发言有问题');
  expect(context.systemPrompt).not.toContain('他人的私密判断');
});

it('投票事件不带 thinking 时，按 game/player/event 回读当时的决策理由', async () => {
  const findMany = jest.fn().mockResolvedValue([
    {
      eventId: 'ev-vote',
      snapshot: {
        reasoning: '2号首夜发言回避刀口，先归票他',
        systemPrompt: '旧 Prompt 不应被复制',
      },
    },
  ]);
  const runtime = createRuntime(
    jest.fn(),
    [
      {
        id: 'ev-vote',
        sequence: 21,
        day: 1,
        phase: 'vote',
        actorId: 'p',
        actionType: 'vote',
        visibility: 'public',
        content: { voterSeatNo: 1, targetSeatNo: 2, voteRound: 0 },
      },
    ],
    { decisionContext: findMany },
  );

  const context = await runtime.prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'day_speech',
    actionType: 'speech',
    position: { day: 2, phase: '普通发言', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
  });

  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { gameId: 'g', playerId: 'p', eventId: { in: ['ev-vote'] } },
    }),
  );
  expect(context.systemPrompt).toContain('[你的私有理由·当时] 2号首夜发言回避刀口，先归票他');
  expect(context.systemPrompt).not.toContain('旧 Prompt 不应被复制');
});

it('未用解药的女巫死亡后仍保留生前刀口，不能获知后续夜晚的刀口', async () => {
  const events = [1, 2, 3].map((day) => ({
    sequence: day,
    day,
    phase: 'night',
    actorId: 'wolf',
    actionType: 'wolf_kill',
    visibility: 'wolf_kill',
    content: { targetSeatNo: day + 1 },
  }));
  const context = await createRuntime(jest.fn(), events, {
    role: 'witch',
    deathDay: 2,
  }).prepareContextPublic({
    gameId: 'g',
    playerId: 'p',
    scenario: 'last_words',
    actionType: 'speech',
    position: { day: 3, phase: '观察权限验证', round: 0, aliveSeats: [2, 3] },
  });
  expect((context.replay!.evidence as Array<{ sequence: number }>).map((e) => e.sequence)).toEqual([
    1, 2,
  ]);
});
