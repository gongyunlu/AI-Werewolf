import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { AgentRuntimeService } from './agent-runtime.service';
import { PromptService } from '../observability/prompt.service';
jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

it('缓存等待期间取消后，不能回放发言或返回成功', async () => {
  const { runtime, context } = setup(0);
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
    runtime.streamSpeech(context, { signal: controller.signal, onContent, onThinking }),
  ).rejects.toThrow('测试取消');
  expect(onContent).not.toHaveBeenCalled();
  expect(onThinking).not.toHaveBeenCalled();
  read.mockRestore();
});

it('发言按配置轮次续写思考并逐片段外发，正文只在最后调用一次', async () => {
  const { runtime, context, stream } = setup(3, {
    streams: ['初判', '复核一', '复核二', '复核三', '正文'],
  });
  const onThinking = jest.fn();
  const onContent = jest.fn();

  const result = await runtime.streamSpeech(context, { onThinking, onContent });

  expect(stream).toHaveBeenCalledTimes(5);
  expect(onThinking.mock.calls.flat().join('')).toBe('初判。复核一。复核二。复核三。');
  expect(onContent.mock.calls.flat().join('')).toBe('正文。');
  expect(result).toMatchObject({
    thinking: '初判。\n\n复核一。\n\n复核二。\n\n复核三。',
    content: '正文。',
  });
});

it('轮次为 0 时只跑一轮思考与一次终稿', async () => {
  const { runtime, context, stream } = setup(0, { streams: ['初判', '正文'] });

  const result = await runtime.streamSpeech(context);

  expect(stream).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ thinking: '初判。', content: '正文。' });
});

it('调用方可以覆盖轮次，狼队讨论因此不叠加思考轮', async () => {
  const { runtime, context, stream } = setup(3, { streams: ['初判', '正文'] });

  await runtime.streamSpeech(context, { reflectionMaxRounds: 0 });

  expect(stream).toHaveBeenCalledTimes(2);
});

it('决策同样可以覆盖轮次，狼队提案与狼队投票因此只调用两次', async () => {
  const final = { reasoning: '按投票结果归票。', decision: { action: 'hold' } };
  const { runtime, context, invoke, stream } = setup(3, {
    decisions: [final],
    streams: ['初判'],
  });

  const result = await runtime.decide(
    context,
    z.object({ action: z.enum(['explode', 'hold']) }),
    undefined,
    { reflectionMaxRounds: 0 },
  );

  expect(result).toEqual(final);
  expect(stream).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  const [messages] = invoke.mock.calls[0];
  expect(
    messages.filter((message) => message.getType() === 'ai').map((message) => message.content),
  ).toEqual(['初判。']);
});

it('决策同样走思考轮，终稿带着完整思考历史只提交一次', async () => {
  const final = { reasoning: '保留人数，继续发言。', decision: { action: 'hold' } };
  const { runtime, context, invoke, stream } = setup(2, {
    decisions: [final],
    streams: ['初判', '复核一', '复核二'],
  });

  const result = await runtime.decide(context, z.object({ action: z.enum(['explode', 'hold']) }));

  expect(result).toEqual(final);
  expect(stream).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(context.replay).toMatchObject({
    reflectionMaxRounds: 2,
    thinkingRounds: ['初判。', '复核一。', '复核二。'],
  });
  const [messages] = invoke.mock.calls[0];
  expect(String(messages[0].content)).toContain('事件#30');
  // 最后一轮的纠正也必须进入终稿，不能只传前两轮。
  expect(
    messages.filter((message) => message.getType() === 'ai').map((message) => message.content),
  ).toEqual(['初判。', '复核一。', '复核二。']);
  expect(String(messages.at(-1)!.content)).toContain('reasoning');
});

function setup(rounds: number, scripts: { decisions?: unknown[]; streams?: string[] } = {}) {
  const decisions = [...(scripts.decisions ?? [])];
  const streams = [...(scripts.streams ?? [])];
  const config = {
    get: (key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? rounds : undefined),
  };
  const invoke = jest.fn(async (_messages: BaseMessage[]) => {
    const parsed = decisions.shift() ?? null;
    return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
  });
  const stream = jest.fn(async () => {
    const text = streams.shift() ?? '未预设的流式片段';
    return (async function* () {
      for (const piece of [text, '。']) yield new AIMessage(piece);
    })();
  });
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
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const context = {
    systemPrompt: '你是1号狼人。事件#30：首夜验4号金水。',
    player: { id: 'p', gameId: 'g', modelName: 'test', role: 'werewolf', seatNo: 1 },
    game: { id: 'g' },
    scenario: 'day_speech',
    replay: { evidence: [{ sequence: 30 }] },
  } as unknown as Awaited<ReturnType<AgentRuntimeService['prepareContextPublic']>>;
  return { runtime, context, invoke, stream };
}
