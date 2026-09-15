import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { WitchAntidoteNode } from '../game-engine/nodes/night/witch-antidote.node';
import { FALLBACK_TEMPLATES, renderTemplate } from '../observability/prompt-templates';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

/** 决策前的思考轮是普通流式调用，这里只要求它产出一段非空思考。 */
const thinkingStream = async () =>
  (async function* () {
    yield new AIMessage('核对可见事实后行动。');
  })();

function setup(output: unknown) {
  const invoke = jest
    .fn()
    .mockResolvedValue({ raw: new AIMessage(JSON.stringify(output)), parsed: output });
  const structured = jest.fn().mockReturnValue({ invoke });
  jest
    .mocked(ChatOpenAI)
    .mockImplementation(
      () => ({ withStructuredOutput: structured, stream: thinkingStream }) as never,
    );
  const prisma = { decisionContext: { upsert: jest.fn() } };
  const runtime = createAgentRuntime(
    ...([
      { get: jest.fn((key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 0 : undefined)) },
      prisma,
      {},
      {},
      {},
      {},
      {},
      { trace: jest.fn().mockReturnValue({ callbacks: [] }) },
      {
        render: jest.fn(async (name, variables) => ({
          name,
          version: null,
          text: renderTemplate(
            FALLBACK_TEMPLATES[name as keyof typeof FALLBACK_TEMPLATES],
            variables,
          ),
        })),
      },
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const context = {
    game: { id: 'g' },
    player: { id: 'witch', gameId: 'g', role: 'witch', seatNo: 5, modelName: 'deepseek' },
    scenario: 'night_action',
    systemPrompt: '只能救1号，或不用药。',
    replay: {},
    experiment: {},
    pendingMemoryUsages: [],
    pendingKnowledgeUsages: [],
  };
  return { runtime, context, prisma, invoke, structured };
}

it.each(['antidote', 'skip'])(
  '女巫 %s 的理由和动作来自同一次结果，并保存私有快照',
  async (action) => {
    const output = {
      reasoning:
        action === 'antidote' ? '首夜保留好人行动机会，救1号。' : '本次选择保留解药，不救人。',
      decision: action === 'antidote' ? { action, targetSeatNo: 1 } : { action },
    };
    const { runtime, context, prisma, invoke } = setup(output);
    jest.spyOn(runtime, 'prepareContextPublic').mockResolvedValue(context as never);
    const event = { id: 'e', gameId: 'g', actorId: 'witch', day: 1, actionType: 'witch_save' };
    const writer = {
      writeNightPromptEvent: jest.fn(),
      writeWitchAntidoteEvent: jest.fn().mockResolvedValue(event),
    };
    const result = await new WitchAntidoteNode(runtime).create()({ eventWriter: writer } as never)({
      gameId: 'g',
      currentDay: 1,
      wolfTarget: 'target',
      players: [
        { id: 'witch', role: 'witch', seatNo: 5, isAlive: true, hasAntidoteUsed: false },
        { id: 'target', role: 'villager', seatNo: 1, isAlive: true },
      ],
    } as never);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      action === 'antidote' ? expect.objectContaining({ witchAntidoteTarget: 'target' }) : {},
    );
    expect(writer.writeWitchAntidoteEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSeatNo: action === 'antidote' ? 1 : 0,
        thinking: output.reasoning,
      }),
    );
    expect(prisma.decisionContext.upsert.mock.calls[0][0].create.snapshot).toMatchObject({
      ...output,
      decisionMode: 'joint',
    });
    expect(prisma.decisionContext.upsert).toHaveBeenCalledTimes(1);
  },
);

it('不完整的结构化动作不得作为已完成决策保存', async () => {
  const { runtime, context, prisma } = setup({
    reasoning: '救1号',
    decision: { action: 'antidote' },
  });
  await expect(
    runtime.decide(
      context as never,
      z.object({ action: z.literal('antidote'), targetSeatNo: z.number() }),
    ),
  ).rejects.toThrow();
  expect(context.replay).not.toHaveProperty('decision');
  expect(prisma.decisionContext.upsert).not.toHaveBeenCalled();
});

it('结构合法的候选在事件提交之前不写入决策快照，错误事件也不能确认它', async () => {
  const { runtime, context, prisma } = setup({ reasoning: '不救', decision: { action: 'skip' } });
  await runtime.decide(context as never, z.object({ action: z.literal('skip') }));
  expect(prisma.decisionContext.upsert).not.toHaveBeenCalled();
  const event = { id: 'e', gameId: 'g', actorId: 'other', day: 1, actionType: 'witch_save' };
  await runtime.recordExperienceUsages(context as never, event);
  expect(prisma.decisionContext.upsert).not.toHaveBeenCalled();
  await runtime.recordExperienceUsages(context as never, { ...event, actorId: 'witch' });
  expect(prisma.decisionContext.upsert).toHaveBeenCalledTimes(1);
  expect(prisma.decisionContext.upsert.mock.calls[0][0].create.snapshot).toMatchObject({
    reasoning: '不救',
    decision: { action: 'skip' },
  });
});

it('重复提交命中原 Event 时不能把新尝试的输入确认为原行动证据', async () => {
  const { runtime, context, prisma } = setup({ reasoning: '不救', decision: { action: 'skip' } });
  const original = {
    actionKey: 'a',
    traceId: 't',
    attemptId: 'first',
    outputObservationId: 'first-output',
    startedAt: new Date().toISOString(),
  };
  const candidate = {
    ...context,
    source: { ...original, attemptId: 'second', outputObservationId: 'second-output' },
  };
  const event = {
    id: 'e',
    gameId: 'g',
    actorId: 'witch',
    day: 1,
    actionType: 'witch_save',
    source: original,
  };
  await runtime.recordExperienceUsages(candidate as never, event);
  expect(prisma.decisionContext.upsert).not.toHaveBeenCalled();
});
