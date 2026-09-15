import { HumanMessage } from '@langchain/core/messages';
import { Langfuse } from 'langfuse-langchain';
import { LangfuseService } from './langfuse.service';
import { ModelCallService } from '../llm/model-call.service';
import { createActionSource } from './action-source';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PromptService } from './prompt.service';
import { PROMPT_NAMES } from './prompt-templates';

jest.mock('langfuse-langchain', () => {
  // 绕过项目的空回调映射；SDK 的 ESM 依赖由 Node 加载。
  const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
  return { __esModule: true, ...nativeRequire('langfuse-langchain'), Langfuse: jest.fn() };
});

beforeEach(() => jest.clearAllMocks());

it('并发裁判只创建目标调用 span，不改写评估运行根 trace 的名称或玩家归属', async () => {
  const client = {
    trace: jest.fn(),
    span: jest.fn(),
    generation: jest.fn(),
    _updateSpan: jest.fn(),
    _updateGeneration: jest.fn(),
  };
  client.trace.mockImplementation(() => ({ client, traceId: 'evaluation-run' }));
  client.span.mockImplementation((params) => ({
    client,
    traceId: params.traceId,
    observationId: params.id,
  }));
  jest.mocked(Langfuse).mockImplementation(() => client as never);
  const service = new LangfuseService({ get: () => 'test' } as never);
  for (const playerId of ['p1', 'p2']) {
    const source = { ...createActionSource('run/' + playerId), traceId: 'evaluation-run' };
    const trace = service.trace({
      runName: 'judge',
      scenario: 'judge',
      gameId: 'g',
      playerId,
      modelName: 'test',
      source,
    });
    await trace.callbacks[0].handleChatModelStart(
      { lc: 1, type: 'not_implemented', id: ['ChatOpenAI'] },
      [[new HumanMessage('授权判分材料')]],
      playerId,
    );
    await trace.callbacks[0].handleLLMEnd({ generations: [[{ text: '判分结果' }]] }, playerId);
  }
  expect(client.trace).not.toHaveBeenCalled();
  expect(client.span).toHaveBeenCalledTimes(2);
  expect(client.generation).toHaveBeenCalledTimes(2);
});

it.each(['trace', 'span'] as const)(
  'SDK %s 同步异常时关闭本次回调，保留行动来源且不阻断游戏',
  (method) => {
    const client = { trace: jest.fn(), span: jest.fn() };
    client.trace.mockImplementation(() => ({ client, traceId: 'trace' }));
    client[method].mockImplementation(() => {
      throw new Error('观测队列不可用');
    });
    jest.mocked(Langfuse).mockImplementation(() => client as never);
    const service = new LangfuseService({ get: () => 'test' } as never);
    const source = createActionSource('action-key');

    expect(() => service.startAttempt(source, 'g', 'p')).not.toThrow();
    const trace = service.trace({
      runName: 'speech',
      gameId: 'g',
      playerId: 'p',
      modelName: 'test',
      source,
    });

    expect(trace.callbacks).toEqual([]);
    expect(trace.observationId).toEqual(expect.any(String));
    expect(trace.metadata).toMatchObject({
      actionKey: source.actionKey,
      attemptId: source.attemptId,
    });
  },
);

it.each([
  ['chat', '_updateSpan'],
  ['chat', 'generation'],
  ['llm', '_updateSpan'],
  ['llm', 'generation'],
] as const)(
  'SDK %s 入口未等待 generation/start 时，%s 异常也不会产生未处理拒绝',
  async (entry, method) => {
    const client = {
      trace: jest.fn(),
      span: jest.fn(),
      _updateSpan: jest.fn(),
      generation: jest.fn(),
    };
    client.trace.mockImplementation(() => ({ client, traceId: 'trace' }));
    client.span.mockImplementation((params) => ({
      client,
      traceId: params.traceId,
      observationId: params.id,
    }));
    client[method].mockImplementation(() => {
      throw new Error('生成追踪不可用');
    });
    jest.mocked(Langfuse).mockImplementation(() => client as never);
    const service = new LangfuseService({ get: () => 'test' } as never);
    const source = createActionSource('action-key');
    const trace = service.trace({
      runName: 'speech',
      gameId: 'g',
      playerId: 'p',
      modelName: 'test',
      source,
    });
    const callback = trace.callbacks[0];
    const generationStart = jest.spyOn(callback, 'handleGenerationStart');
    const model: Parameters<typeof callback.handleChatModelStart>[0] = {
      lc: 1,
      type: 'not_implemented',
      id: ['ChatOpenAI'],
    };

    const started =
      entry === 'chat'
        ? callback.handleChatModelStart(model, [[new HumanMessage('测试')]], 'run', undefined, {
            invocation_params: { model: 'test' },
          })
        : callback.handleLLMStart(model, ['测试'], 'run', undefined, {
            invocation_params: { model: 'test' },
          });
    // 直接检查 SDK 未 await 的内部 Promise，红测也不会污染 Jest 的进程级拒绝处理。
    const generationSettled = expect(
      generationStart.mock.results[0].value,
    ).resolves.toBeUndefined();
    await expect(started).resolves.toBeUndefined();
    await generationSettled;
  },
);

it.each([
  ['同项目密钥轮换', 'project-a', 'https://trace.test/', true],
  ['恢复时改绑项目', 'project-b', 'https://trace.test', false],
  ['恢复时更换服务', 'project-a', 'https://other.test', false],
  ['项目查询失败', null, 'https://trace.test', false],
] as const)(
  '冻结 Prompt 的原生关联核对项目来源：%s',
  async (_case, currentProject, host, linked) => {
    const project = jest.fn().mockResolvedValue({ data: [{ id: 'project-a' }] });
    const client = {
      trace: jest.fn(),
      generation: jest.fn(),
      shutdownAsync: jest.fn(),
      api: { projectsGet: project },
      getPrompt: jest.fn().mockResolvedValue({ prompt: '项目 A 冻结正文', version: 7 }),
    };
    client.trace.mockImplementation(() => ({ client, traceId: 'trace' }));
    jest.mocked(Langfuse).mockImplementation(() => client as never);
    const config = (baseUrl: string, key: string) =>
      ({
        get: (name: string) =>
          ({
            LANGFUSE_HOST: baseUrl,
            LANGFUSE_PUBLIC_KEY: key,
            LANGFUSE_SECRET_KEY: key + '-secret',
          })[name],
      }) as never;
    const name = PROMPT_NAMES.agentTurnContinue;
    const promptsA = new PromptService(config('https://trace.test', 'key-a'));
    const frozen = await promptsA.captureSnapshot([name]);
    if (currentProject) project.mockResolvedValue({ data: [{ id: currentProject }] });
    else project.mockRejectedValue(new Error('项目查询不可用'));
    const promptsB = new PromptService(config(host, 'rotated-key'));
    const restored = await promptsB.render(name, undefined, JSON.parse(JSON.stringify(frozen)));
    expect(restored.text).toBe('项目 A 冻结正文');
    expect(client.getPrompt).toHaveBeenCalledTimes(1);
    const service = new LangfuseService(config(host, 'rotated-key'));
    await service.onModuleInit();
    for (const variant of [
      restored,
      { ...restored, source: 'local_release' },
      { ...restored, source: 'local_default' },
      { ...restored, origin: undefined },
    ]) {
      const trace = service.trace({
        runName: 'speech',
        gameId: 'g',
        playerId: 'p',
        modelName: 'test',
        promptName: name,
        promptVersion: variant.version,
        promptSource: variant.source,
        promptOrigin: (variant as { origin?: unknown }).origin,
      } as never);
      await trace.callbacks[0].handleChatModelStart(
        { lc: 1, type: 'not_implemented', id: ['ChatOpenAI'] },
        [[new HumanMessage(restored.text)]],
        randomUUID(),
        undefined,
        { invocation_params: { model: 'test' } },
        trace.tags,
        trace.metadata,
      );
    }
    expect(client.generation.mock.calls[0][0].prompt).toEqual(
      linked ? { name, version: 7 } : undefined,
    );
    for (const call of client.generation.mock.calls.slice(1))
      expect(call[0].prompt).toBeUndefined();
    expect(frozen[name]).toHaveProperty('origin', {
      baseUrl: 'https://trace.test',
      projectId: 'project-a',
    });
    expect(JSON.stringify(frozen)).not.toContain('key-a');
  },
);

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
