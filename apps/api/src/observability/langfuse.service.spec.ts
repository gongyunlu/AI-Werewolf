import { HumanMessage } from '@langchain/core/messages';
import { Langfuse } from 'langfuse-langchain';
import { LangfuseService } from './langfuse.service';
import { ModelCallService } from '../llm/model-call.service';
import { z } from 'zod';

jest.mock('langfuse-langchain', () => {
  // 绕过项目的空回调映射；SDK 的 ESM 依赖由 Node 加载。
  const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
  return { __esModule: true, ...nativeRequire('langfuse-langchain'), Langfuse: jest.fn() };
});

beforeEach(() => jest.clearAllMocks());

it.each(['glm-5.3', 'minimax-m3', 'doubao-seed-2-0-pro-260215'])(
  '追踪保留实际 SDK 请求协议且不包含凭证：%s',
  async (modelName) => {
    const client = {
      trace: jest.fn(),
      generation: jest.fn(),
      span: jest.fn(),
      _updateGeneration: jest.fn(),
      _updateSpan: jest.fn(),
      shutdownAsync: jest.fn(),
    };
    client.trace.mockImplementation(() => ({ client, traceId: 'request-trace' }));
    jest.mocked(Langfuse).mockImplementation(() => client as never);
    const values: Record<string, unknown> = {
      LANGFUSE_PUBLIC_KEY: 'trace-public',
      LANGFUSE_SECRET_KEY: 'trace-secret',
      LANGFUSE_HOST: 'https://trace.test',
      ARK_API_KEY: 'provider-secret',
      ARK_BASE_URL: 'https://provider.test/v3',
      LLM_FIRST_CHUNK_TIMEOUT_MS: 5000,
      LLM_STREAM_IDLE_TIMEOUT_MS: 5000,
      LLM_STREAM_MAX_DURATION_MS: 10000,
    };
    const config = { get: (key: string) => values[key] } as never;
    const traces = new LangfuseService(config);
    const model = new ModelCallService(config);
    let body: Record<string, unknown> = {};
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      const output = JSON.stringify({ action: 'hold' });
      const delta = body.tools
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call-test',
                type: 'function',
                function: { name: 'extract', arguments: output },
              },
            ],
          }
        : { content: output };
      const chunks = [
        { index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: body.tools ? 'tool_calls' : 'stop' },
      ]
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [choice] })}\n\n`,
        )
        .join('');
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    try {
      await expect(
        model.structured(
          modelName,
          z.object({ action: z.literal('hold') }),
          [new HumanMessage('测试')],
          () =>
            traces.trace({
              gameId: 'test-game',
              playerId: 'test-player',
              modelName,
              runName: 'request-test',
            }),
        ),
      ).resolves.toEqual({ action: 'hold' });
      const observed = client.generation.mock.calls[0][0].metadata.modelRequest;
      const { messages: _messages, stream_options: _options, ...wireParameters } = body;
      expect(observed).toEqual(wireParameters);
      expect(observed).not.toHaveProperty('max_tokens');
      expect(observed).not.toHaveProperty('max_completion_tokens');
      expect(JSON.stringify(client.generation.mock.calls)).not.toContain('provider-secret');
      expect(JSON.stringify(client.generation.mock.calls)).not.toContain('trace-secret');
    } finally {
      fetch.mockRestore();
      await traces.onModuleDestroy();
    }
  },
);

it('并发调用分别归入自己的 trace，单独的流式调用也具有 session 和 user', async () => {
  const updateGeneration = jest.fn();
  const client = {
    trace: jest.fn(),
    generation: jest.fn(),
    _updateGeneration: updateGeneration,
    shutdownAsync: jest.fn().mockResolvedValue(undefined),
  };
  let id = 0;
  client.trace.mockImplementation((params: { id?: string }) => ({
    client,
    traceId: params.id ?? `trace-${++id}`,
  }));
  jest.mocked(Langfuse).mockImplementation(() => client as never);
  const values: Record<string, string> = {
    LANGFUSE_PUBLIC_KEY: 'test',
    LANGFUSE_SECRET_KEY: 'test',
    LANGFUSE_HOST: 'https://trace.test',
  };
  const service = new LangfuseService({ get: (key: string) => values[key] } as never);
  const a = service.trace({
    runName: 'speech-thinking',
    gameId: 'game-a',
    playerId: 'player-a',
    modelName: 'test',
  });
  const b = service.trace({
    runName: 'speech-thinking',
    gameId: 'game-b',
    playerId: 'player-b',
    modelName: 'test',
  });
  expect(Langfuse).toHaveBeenCalledTimes(1);
  expect(a.callbacks[0]).not.toBe(b.callbacks[0]);
  expect(client.trace).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'game-a', userId: 'player-a' }),
  );
  expect(client.trace).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'game-b', userId: 'player-b' }),
  );

  for (const [trace, runId] of [
    [a, 'run-a'],
    [b, 'run-b'],
  ] as const) {
    await trace.callbacks[0].handleChatModelStart(
      { lc: 1, type: 'not_implemented', id: ['ChatOpenAI'] },
      [[new HumanMessage('test')]],
      runId,
      undefined,
      { invocation_params: { model: 'test' } },
      trace.tags,
      trace.metadata,
      trace.runName,
    );
  }
  for (const [trace, runId, content] of [
    [a, 'run-a', 'answer-a'],
    [b, 'run-b', 'answer-b'],
  ] as const) {
    const generation = { text: content };
    await trace.callbacks[0].handleLLMEnd({ generations: [[generation]] }, runId);
  }
  expect(updateGeneration).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'run-a',
      traceId: 'trace-1',
      output: 'answer-a',
    }),
  );
  expect(updateGeneration).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'run-b',
      traceId: 'trace-2',
      output: 'answer-b',
    }),
  );
  await service.onModuleDestroy();
  expect(client.shutdownAsync).toHaveBeenCalledTimes(1);
});
