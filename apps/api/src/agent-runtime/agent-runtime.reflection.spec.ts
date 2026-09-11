import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { reviewed } from '../testing/turn-review.fixture';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AgentRuntimeService } from './agent-runtime.service';
import { PromptService } from '../observability/prompt.service';
jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

it('缓存等待期间取消后，不能回放发言或返回成功', async () => {
  const { runtime, context } = setup([]);
  const controller = new AbortController();
  const onContent = jest.fn();
  const onThinking = jest.fn();
  const cached = { result: { thinking: '缓存思考', content: '缓存发言' } };
  const read = jest
    .spyOn(runtime as unknown as { durable: (...args: unknown[]) => Promise<unknown> }, 'durable')
    .mockImplementation(async () => {
      controller.abort(new Error('测试取消'));
      return cached;
    });
  await expect(
    runtime.streamSpeech(context, 'thread', { signal: controller.signal, onContent, onThinking }),
  ).rejects.toThrow('测试取消');
  expect(onContent).not.toHaveBeenCalled();
  expect(onThinking).not.toHaveBeenCalled();
  read.mockRestore();
});

function setup(outputs: unknown[], streamText?: string) {
  const config = { get: (key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 3 : undefined) };
  const invoke = jest.fn().mockImplementation(async () => {
    const parsed = outputs.shift();
    return { raw: new AIMessage(JSON.stringify(parsed ?? null)), parsed };
  });
  const stream = jest.fn(async () =>
    (async function* () {
      yield new AIMessage(streamText ?? 'draft');
    })(),
  );
  jest
    .mocked(ChatOpenAI)
    .mockImplementation(() => ({ withStructuredOutput: () => ({ invoke }), stream }) as never);
  const runtime = createAgentRuntime(
    ...([
      config,
      {},
      {},
      {},
      {},
      {},
      {},
      { trace: (o: object) => ({ ...o, callbacks: [] }) },
      new PromptService(config as never),
      { load: async () => [new AIMessage('历史决策：hold')], replace: jest.fn() },
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const context = {
    systemPrompt: '你是1号狼人。事件#30：首夜验4号金水。',
    player: { id: 'p', gameId: 'g', modelName: 'test', role: 'werewolf', seatNo: 1 },
    game: { id: 'g' },
    scenario: 'day_speech',
    replay: { evidence: [{ sequence: 30 }] },
  } as unknown as Awaited<ReturnType<AgentRuntimeService['prepareContextPublic']>>;
  return { runtime, context, invoke };
}

it('决策经反思修订后才保存最终选择，并保留完整质量记录', async () => {
  const draft = { reasoning: '不自爆', decision: { action: 'explode' } };
  const final = { reasoning: '保留狼队人数，不自爆', decision: { action: 'hold' } };
  const { runtime, context, invoke } = setup([
    draft,
    {
      ...reviewed(),
      issues: [{ kind: 'action_reason', explanation: '动作与理由相反', evidenceSequences: [] }],
    },
    final,
    reviewed(),
  ]);
  const result = await runtime.decide(context, z.object({ action: z.enum(['explode', 'hold']) }));
  expect(result).toEqual(final);
  expect(context.replay?.reflection).toMatchObject({ status: 'passed', initial: draft, final });
  expect(invoke).toHaveBeenCalledTimes(4);
  for (const [messages] of invoke.mock.calls)
    expect(String(messages[0].content)).toContain('事件#30');
});

it('发言初稿不推送；复核实际正文后仅发布最终文字', async () => {
  const { runtime, context, invoke } = setup(
    [
      {
        ...reviewed(),
        issues: [{ kind: 'claim_change', explanation: '首夜已说4号金水', evidenceSequences: [30] }],
      },
      {
        reasoning: '保持已公开口径',
        contentEdits: [{ before: '第一夜2号查杀', after: '首夜4号金水，第二夜6号查杀。' }],
      },
      reviewed(),
    ],
    '第一夜2号查杀',
  );
  const seen: string[] = [];
  invoke.mockImplementation(async () => {
    expect(seen).toEqual([]);
    const index = invoke.mock.calls.length;
    const parsed =
      index === 1
        ? {
            ...reviewed(),
            issues: [
              { kind: 'claim_change', explanation: '首夜已说4号金水', evidenceSequences: [30] },
            ],
          }
        : index === 2
          ? {
              reasoning: '保持已公开口径',
              contentEdits: [{ before: '第一夜2号查杀', after: '首夜4号金水，第二夜6号查杀。' }],
            }
          : reviewed();
    return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
  });
  const result = await runtime.streamSpeech(context, 'g/p', { onContent: (t) => seen.push(t) });
  expect(seen).toEqual(['首夜4号金水，第二夜6号查杀。']);
  expect(result.content).toBe(seen[0]);
  expect(String(invoke.mock.calls[0][0][0].content)).toContain('历史决策：hold');
  expect(String(invoke.mock.calls[0][0][0].content)).toContain('第一夜2号查杀');
});

it.each(['glm-5.3', 'test'])(
  '%s 复核格式错误时，重试要求 issues 而非决策字段',
  async (modelName) => {
    const draft = { reasoning: '保留狼队人数', decision: { action: 'hold' } };
    const { runtime, context, invoke } = setup([draft, undefined, reviewed()]);
    context.player.modelName = modelName;

    await expect(
      runtime.decide(context, z.object({ action: z.enum(['explode', 'hold']) })),
    ).resolves.toEqual(draft);

    expect(invoke).toHaveBeenCalledTimes(3);
    const retryHint = String(invoke.mock.calls[2][0].at(-1).content);
    expect(retryHint).toContain('issues');
    expect(retryHint).not.toContain('decision');
    expect(context.replay?.reflection).toMatchObject({ status: 'passed', initial: draft });
  },
);

it('替换片段无法定位时只重试修订，复核修订后的全文才发布', async () => {
  const review = reviewed([{ kind: 'timeline', explanation: '应为今天', evidenceSequences: [30] }]);
  const { runtime, context, invoke } = setup(
    [
      review,
      { reasoning: '修正日期', contentEdits: [{ before: '并不存在的句子', after: '今天' }] },
      { reasoning: '修正日期', contentEdits: [{ before: '昨天', after: '今天' }] },
      reviewed(),
    ],
    '昨天4号发言。首夜4号金水。',
  );
  const seen: string[] = [];
  const result = await runtime.streamSpeech(context, 'g/p', { onContent: (t) => seen.push(t) });
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(String(invoke.mock.calls[3][0][0].content)).toContain('今天4号发言。首夜4号金水。');
  expect(seen).toEqual(['今天4号发言。首夜4号金水。']);
  expect(result.content).toBe(seen[0]);
});

it.each(['glm-5.3', 'test'])(
  '%s 发言修订格式错误时，重试保持 reasoning/contentEdits 契约',
  async (modelName) => {
    const final = { reasoning: '保持已经公开的查验口径', content: '首夜4号金水，昨夜6号查杀。' };
    const { runtime, context, invoke } = setup([
      {
        ...reviewed(),
        issues: [
          { kind: 'claim_change', explanation: '首夜已经报4号金水', evidenceSequences: [30] },
        ],
      },
      undefined,
      { reasoning: final.reasoning, contentEdits: [{ before: 'draft', after: final.content }] },
      reviewed(),
    ]);
    context.player.modelName = modelName;
    const published: string[] = [];

    const result = await runtime.streamSpeech(context, 'g/p', {
      onContent: (text) => published.push(text),
    });

    expect(invoke).toHaveBeenCalledTimes(4);
    const retryHint = String(invoke.mock.calls[2][0].at(-1).content);
    expect(retryHint).toContain('reasoning');
    expect(retryHint).toContain('content');
    expect(retryHint).not.toContain('decision');
    expect(result.content).toBe(final.content);
    expect(published).toEqual([final.content]);
    expect(context.replay?.reflection).toMatchObject({ status: 'passed', final });
  },
);
