import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { AgentRuntimeService } from './agent-runtime.service';
import { PromptService } from '../observability/prompt.service';
import { validateEnv, type Env } from '../config/env.validation';
import { PlayerTurnService } from '../player-turn/player-turn.service';
import { ModelCallService } from '../llm/model-call.service';
import { replayDecision, type DecisionReplaySnapshot } from '../player-turn/decision-replay';
import { PLAYER_TURN_PROMPT_NAMES } from '../observability/prompt-templates';
import { buildVoteSchema } from '../game-engine/nodes/day/vote.node';
import { buildSeerCheckSchema } from '../game-engine/nodes/night/seer-check.node';
import { ProposeKillDecisionSchema } from '../game-engine/nodes/night/werewolf-collaboration';

// 保留真实 ChatOpenAI、HTTP 编解码和输出解析器，只替换网络响应。
const decisionSchema = z.object({ action: z.literal('hold') });
const valid = { reasoning: '没有自爆收益，继续发言。', decision: { action: 'hold' } };

function setup(modelName = 'glm-5.3', overrides: Partial<Env> = {}) {
  const values: Record<string, unknown> = {
    ARK_API_KEY: 'test-key',
    ARK_BASE_URL: 'https://provider.test/v3',
    TURN_REFLECTION_MAX_ROUNDS: 0,
    LLM_CALL_TIMEOUT_MS: 1000,
    LLM_FIRST_CHUNK_TIMEOUT_MS: 1000,
    LLM_STREAM_IDLE_TIMEOUT_MS: 1000,
    LLM_STREAM_MAX_DURATION_MS: 5000,
    ...overrides,
  };
  const config = { get: (name: string) => values[name] };
  const runtime = createAgentRuntime(
    ...([
      config,
      {},
      {},
      {},
      {},
      {},
      {},
      {
        trace: (params: Record<string, unknown>) => ({
          callbacks: [],
          metadata: params,
          runName: params.runName,
          tags: [],
        }),
      },
      new PromptService(config as never),
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const context = {
    systemPrompt: '按当前可见局面行动。',
    scenario: 'night_action',
    player: { id: 'p', gameId: 'g', modelName, seatNo: 3, role: 'werewolf' },
    replay: {},
  } as Parameters<AgentRuntimeService['decide']>[0];
  const requests: Record<string, any>[] = [];
  const responses: Response[] = [];
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://provider.test/v3/chat/completions');
    requests.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    if (!response) throw new Error('意外的额外模型调用');
    return response;
  });
  return { runtime, context, requests, responses, fetch, config };
}

function completion(message: object, finishReason = 'stop', outputTokens = 10) {
  const delta = { ...message } as Record<string, unknown>;
  if (Array.isArray(delta.tool_calls))
    delta.tool_calls = delta.tool_calls.map((tool, index) => ({ ...tool, index }));
  return streamResponse([delta], finishReason, outputTokens);
}

function toolResult(args: unknown = valid, finishReason = 'tool_calls') {
  return completion(
    {
      content: null,
      tool_calls: [
        {
          id: 'call-test',
          type: 'function',
          function: { name: 'extract', arguments: JSON.stringify(args) },
        },
      ],
    },
    finishReason,
  );
}

/** 决策前必有一轮思考，它是普通流式调用，不携带结构协议。 */
function thinking(text = '初判：按当前可见局面行动。') {
  return streamResponse([{ content: text }]);
}

function rateLimited(retryAfter = '1') {
  return Response.json(
    { error: { message: 'Rate limited', type: 'rate_limit_error' } },
    { status: 429, headers: { 'retry-after': retryAfter } },
  );
}

function providerStreamError(code: string, eventEnvelope = false, partial = false) {
  const prefix = partial
    ? `data: ${JSON.stringify({
        id: 'partial-response',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '尚未完成的候选' },
            finish_reason: null,
          },
        ],
      })}\n\n`
    : '';
  const body = { error: { code, type: 'TooManyRequests', message: '测试供应商错误' } };
  return new Response(
    `${prefix}${eventEnvelope ? 'event: error\n' : ''}data: ${JSON.stringify(body)}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it.each([
  ['ServerOverloaded', false, false],
  ['ServerOverloaded', true, true],
  ['RequestBurstTooFast', false, true],
  ['RequestBurstTooFast', true, false],
] as const)(
  '流内 %s 错误复用原输入进行一次重试（事件信封=%s，已有片段=%s）',
  async (code, envelope, partial) => {
    const { runtime, context, responses, requests } = setup();
    responses.push(thinking(), providerStreamError(code, envelope, partial), toolResult());

    await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);

    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
  },
);

it.each(['AccountQuotaExceeded', 'AuthenticationError', 'UnknownProviderError'])(
  '未知或需人工处理的流内错误 %s 不按 TooManyRequests 类型笼统重试',
  async (code) => {
    const { runtime, context, responses, requests } = setup();
    responses.push(thinking(), providerStreamError(code));

    await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ code });
    expect(requests).toHaveLength(2);
  },
);

it.each(['AccountQuotaExceeded', 'insufficient_quota'])(
  'HTTP 429 的明确配额耗尽 %s 不占用临时故障重试',
  async (code) => {
    const { runtime, context, responses, requests } = setup();
    responses.push(
      thinking(),
      Response.json({ error: { code, type: code, message: '配额已耗尽' } }, { status: 429 }),
    );

    await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(2);
  },
);

it('持续流内过载耗尽原有一次重试，保留供应商错误码且不伪造 HTTP 状态', async () => {
  const { runtime, context, responses, requests } = setup();
  responses.push(
    thinking(),
    providerStreamError('ServerOverloaded'),
    providerStreamError('ServerOverloaded'),
  );

  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'transient',
    details: { providerCode: 'ServerOverloaded' },
    cause: { code: 'ServerOverloaded', status: undefined },
  });
  expect(requests).toHaveLength(3);
});

function streamResponse(deltas: object[], finishReason = 'stop', outputTokens?: number) {
  const events = [
    ...deltas.map((delta, index) => ({
      delta: { ...(index === 0 ? { role: 'assistant' } : {}), ...delta },
      finish_reason: null,
    })),
    { delta: {}, finish_reason: finishReason },
  ]
    .map(
      (choice) =>
        `data: ${JSON.stringify({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [{ index: 0, ...choice }],
        })}\n\n`,
    )
    .join('');
  const usage =
    outputTokens === undefined
      ? ''
      : `data: ${JSON.stringify({
          id: 'chat-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: outputTokens,
            total_tokens: 10 + outputTokens,
          },
        })}\n\n`;
  return new Response(`${events}${usage}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function controlledStream() {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    cancel() {
      closed = true;
    },
  });
  const write = (text: string) => {
    if (!closed) sink.enqueue(encoder.encode(text));
  };
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    send(delta: object, finishReason: string | null = null) {
      write(
        `data: ${JSON.stringify({
          id: 'timed-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test',
          choices: [
            { index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finishReason },
          ],
        })}\n\n`,
      );
    },
    heartbeat() {
      write(': keep-alive\n\n');
    },
    end() {
      if (!closed) {
        write('data: [DONE]\n\n');
        sink.close();
        closed = true;
      }
    },
  };
}

/** 响应头已返回、正文永远不产生片段的连接。 */
function hangingStream() {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    close() {
      if (!closed) {
        sink.close();
        closed = true;
      }
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each(['glm-5.3', 'kimi-k3'])(
  '%s 的思考轮与终稿持续推理超过 5 分钟仍可完成，且只返回完整候选',
  async (modelName) => {
    jest.useFakeTimers();
    const { runtime, context, responses, requests } = setup(modelName, {
      TURN_REFLECTION_MAX_ROUNDS: 2,
      LLM_CALL_TIMEOUT_MS: 300_000,
      LLM_FIRST_CHUNK_TIMEOUT_MS: 300_000,
      LLM_STREAM_IDLE_TIMEOUT_MS: 300_000,
      LLM_STREAM_MAX_DURATION_MS: 900_000,
    });
    responses.push(
      streamResponse([{ content: '第一轮初判。' }]),
      streamResponse([{ content: '第二轮复核。' }]),
      streamResponse([{ content: '第三轮复核。' }]),
    );
    const stream = controlledStream();
    responses.push(stream.response);
    let settled = false;
    const result = runtime.decide(context, decisionSchema).then((output) => {
      settled = true;
      return output;
    });
    await jest.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 7; i++) {
      stream.send({ reasoning_content: '继续检查可见证据。' });
      await jest.advanceTimersByTimeAsync(100_000);
    }
    expect(settled).toBe(false);
    const output = JSON.stringify(valid);
    stream.send(
      modelName.startsWith('glm')
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call-final',
                type: 'function',
                function: { name: 'extract', arguments: output },
              },
            ],
          }
        : { content: output },
      modelName.startsWith('glm') ? 'tool_calls' : 'stop',
    );
    stream.end();
    await expect(result).resolves.toEqual(valid);
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request.stream).toBe(true);
  },
);

it('工具参数碎片维持进度，但在完整流结束前不会生成待提交动作', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses } = setup('glm-5.3', { LLM_STREAM_IDLE_TIMEOUT_MS: 50 });
  responses.push(thinking());
  const stream = controlledStream();
  responses.push(stream.response);
  const result = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(1);
  const args = JSON.stringify(valid);
  for (let i = 0; i < args.length; i += 10) {
    stream.send({
      tool_calls: [
        {
          index: 0,
          ...(i === 0 ? { id: 'call-args', type: 'function' } : {}),
          function: { ...(i === 0 ? { name: 'extract' } : {}), arguments: args.slice(i, i + 10) },
        },
      ],
    });
    await jest.advanceTimersByTimeAsync(40);
    expect(context.replay?.decision).toBeUndefined();
  }
  stream.send({}, 'tool_calls');
  stream.end();
  await expect(result).resolves.toEqual(valid);
  expect(context.replay?.decision).toEqual(valid.decision);
});

it.each(['first_chunk', 'idle', 'total'] as const)(
  '结构化流保留 %s 保护且记录片段进度',
  async (phase) => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { runtime, context, responses, requests } = setup('glm-5.3', {
      LLM_FIRST_CHUNK_TIMEOUT_MS: phase === 'first_chunk' ? 100 : 1000,
      LLM_STREAM_IDLE_TIMEOUT_MS: phase === 'idle' ? 100 : 1000,
      LLM_STREAM_MAX_DURATION_MS: phase === 'total' ? 100 : 1000,
      LLM_CIRCUIT_MIN_SAMPLES: 1,
      LLM_CIRCUIT_COOLDOWN_MS: 6000,
    });
    responses.push(thinking());
    const stream = controlledStream();
    // 思考轮的成功样本会稀释熔断比例，首次失败不必然打开熔断，structured 还会立刻重试一次。
    // 重试同样受保护约束，所以让它也拿到片段、命中同一阶段。
    const retry = controlledStream();
    responses.push(stream.response, retry.response);
    const result = runtime.decide(context, decisionSchema);
    const rejected = expect(result).rejects.toMatchObject({
      code: 'transient',
      details: { reason: 'timeout', timeoutPhase: phase },
    });
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(1);
    if (phase !== 'first_chunk') stream.send({ reasoning_content: '核对证据' });
    await jest.advanceTimersByTimeAsync(60);
    stream.heartbeat();
    stream.send({ content: ' ', reasoning_content: '\n' });
    if (phase === 'total') stream.send({ reasoning_content: '仍在分析' });
    await jest.advanceTimersByTimeAsync(42);
    if (phase !== 'first_chunk') retry.send({ reasoning_content: '复核后仍无结论' });
    await jest.advanceTimersByTimeAsync(200);
    await rejected;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutPhase: phase,
        receivedChunks: expect.any(Number),
        toolArgumentChars: 0,
      }),
    );
    expect(context.replay?.decision).toBeUndefined();
    expect(requests).toHaveLength(3);
    stream.end();
    retry.end();
    await jest.advanceTimersByTimeAsync(1);
  },
);

it('思考轮进行中被取消，不重试也不提交任何动作', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    TURN_REFLECTION_MAX_ROUNDS: 1,
  });
  responses.push(thinking('第一轮初判。'));
  const stream = controlledStream();
  responses.push(stream.response);
  const controller = new AbortController();
  const result = runtime.decide(context, decisionSchema, controller.signal);
  const reason = new Error('对局已取消');
  const rejected = expect(result).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(1);
  stream.send({ content: '续写第二轮' });
  await jest.advanceTimersByTimeAsync(1);
  controller.abort(reason);
  await rejected;
  expect(requests).toHaveLength(2);
  expect(context.replay?.decision).toBeUndefined();
  expect(context.replay?.thinkingRounds).toBeUndefined();
  stream.end();
});

it('工具协议未调用工具时经过真实 SDK 的空结果会重试，成功后只保留最终待提交候选', async () => {
  const { runtime, context, requests, responses } = setup();
  responses.push(
    thinking(),
    completion({ content: '{"reasoning":"继续游戏","action":"hold"}' }),
    toolResult(),
  );
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[1].tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
  expect(requests[1].messages.at(-1).content).toContain('extract 工具');
  expect(requests[2].messages.at(-1).content).toContain('extract 工具');
  expect(requests[2].messages.at(-1).content).toContain(
    JSON.stringify({ content: '{"reasoning":"继续游戏","action":"hold"}', toolCalls: [] }),
  );
  expect(context.replay?.decision).toEqual(valid.decision);
});

it.each(['minimax-m3', 'glm-5.3', 'doubao-seed-2.1-turbo'])(
  '%s 的思考轮使用普通流，终稿使用与该模型一致的提交协议',
  async (modelName) => {
    const { runtime, context, responses, requests } = setup(modelName, {
      TURN_REFLECTION_MAX_ROUNDS: 1,
    });
    responses.push(
      thinking('第一轮初判。'),
      thinking('第二轮复核。'),
      modelName !== 'glm-5.3' ? completion({ content: JSON.stringify(valid) }) : toolResult(),
    );
    context.game = { id: 'g' } as typeof context.game;
    context.replay = { evidence: [] } as typeof context.replay;
    await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
    expect(requests).toHaveLength(3);
    // 思考轮只做续写，不携带结构协议
    for (const request of requests.slice(0, 2)) {
      expect(request).not.toHaveProperty('tools');
      expect(request).not.toHaveProperty('response_format');
    }
    const final = requests[2];
    if (modelName !== 'glm-5.3') {
      expect(final).not.toHaveProperty('tools');
      expect(final.messages.at(-1).content).not.toContain('extract 工具');
      expect(final.response_format.type).toBe(
        modelName === 'minimax-m3' ? 'json_object' : 'json_schema',
      );
      if (modelName === 'minimax-m3') expect(final.messages.at(-1).content).toContain('"required"');
    } else {
      expect(final.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
      expect(final.messages.at(-1).content).toContain('extract 工具');
    }
    for (const request of requests) {
      expect(request).not.toHaveProperty('max_tokens');
      expect(request).not.toHaveProperty('max_completion_tokens');
    }
  },
);

it('工具字段不满足 schema 时同样只有一次修正机会', async () => {
  const { runtime, context, responses, requests } = setup();
  responses.push(thinking(), toolResult({ ...valid, reasoning: '' }), toolResult());
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[2].messages.at(-1).content).toContain('"path":["reasoning"]');
});

it('连续两次漏掉工具调用后抛出模型错误，不把文本改造成合法动作', async () => {
  const { runtime, context, responses, requests } = setup();
  responses.push(thinking(), completion({ content: 'hold' }), completion({ content: 'hold' }));
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'schema_validation' },
  });
  expect(requests).toHaveLength(3);
});

it('JSON Schema 模型遇到不完整 JSON 后按原协议重试', async () => {
  const { runtime, context, responses, requests } = setup('kimi-k3');
  responses.push(
    thinking(),
    completion({ content: '{' }),
    completion({ content: JSON.stringify(valid) }),
  );
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[2].response_format.type).toBe('json_schema');
  expect(requests[2].messages.at(-1).content).toContain('JSON Schema');
  expect(requests[2].messages.at(-1).content).toContain(
    JSON.stringify({ content: '{', toolCalls: [] }),
  );
});

it('终稿动作不满足 schema 时，错误响应与字段位置一同反馈且不泄漏供应商推理', async () => {
  const { runtime, context, responses, requests } = setup('glm-5.3');
  const invalid = { reasoning: '保持初判。', decision: { action: 'explode' } };
  responses.push(
    thinking(),
    completion(
      {
        content: null,
        reasoning_content: '不应回传的供应商内部推理',
        tool_calls: [
          {
            id: 'invalid-decision',
            type: 'function',
            function: {
              name: 'extract',
              arguments: JSON.stringify(invalid),
            },
          },
        ],
      },
      'tool_calls',
    ),
    toolResult(),
  );
  context.game = { id: 'g' } as typeof context.game;
  context.replay = { evidence: [] } as typeof context.replay;
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  const feedback = requests[2].messages.at(-1).content;
  expect(feedback).toContain(JSON.stringify(['decision', 'action']));
  const previous = JSON.parse(feedback.slice(feedback.lastIndexOf('\n') + 1));
  expect(previous.toolCalls[0].function.arguments).toBe(JSON.stringify(invalid));
  expect(feedback).not.toContain('不应回传的供应商内部推理');
  // 错误工具请求作为数据传递，不生成未配对的 assistant/tool 消息。
  expect(requests[2].messages.slice(requests[1].messages.length)).toEqual([
    { role: 'user', content: feedback },
  ]);
  expect(context.replay?.reasoning).toBe(valid.reasoning);
  expect(context.replay?.decision).toEqual(valid.decision);
});

it.each(['glm-5.3', 'kimi-k3', 'minimax-m3'])(
  '%s 不能把流解析器自动补齐的 JSON 当成完整输出',
  async (modelName) => {
    const { runtime, context, responses, requests } = setup(modelName);
    const content = JSON.stringify(valid).slice(0, -1);
    responses.push(
      thinking(),
      modelName.startsWith('glm')
        ? completion(
            {
              tool_calls: [
                {
                  id: 'broken-call',
                  type: 'function',
                  function: { name: 'extract', arguments: content },
                },
              ],
            },
            'tool_calls',
          )
        : completion({ content }),
    );
    responses.push(
      modelName.startsWith('glm') ? toolResult() : completion({ content: JSON.stringify(valid) }),
    );
    await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
    expect(requests).toHaveLength(3);
  },
);

it('MiniMax 文本协议的错误响应严格校验后按 json_object 重试修正', async () => {
  const { runtime, context, responses, requests } = setup('minimax-m3');
  const invalid = { reasoning: '', decision: { action: 'hold' } };
  const content = `\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``;
  responses.push(
    thinking(),
    completion({ content }),
    completion({ content: JSON.stringify(valid) }),
  );
  context.game = { id: 'g' } as typeof context.game;
  context.replay = { evidence: [] } as typeof context.replay;
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[2].response_format).toEqual({ type: 'json_object' });
  expect(requests[2]).not.toHaveProperty('tools');
  const feedback = requests[2].messages.at(-1).content;
  expect(feedback).toContain('"path":["reasoning"]');
  expect(feedback).toContain(JSON.stringify({ content, toolCalls: [] }));
});

it.each([
  { status: 400, message: 'InvalidParameter', type: 'invalid_request_error' },
  { status: 401, message: 'Unauthorized', type: 'authentication_error' },
])('HTTP $status 不进入模型修正重试', async ({ status, message, type }) => {
  const { runtime, context, responses, requests } = setup();
  responses.push(thinking(), Response.json({ error: { message, type } }, { status }));
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ status });
  expect(requests).toHaveLength(2);
});

it('Retry-After 冷却结束前不发请求，结束后只重试一次并成功', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(thinking(), rateLimited(), toolResult());
  const result = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(999);
  expect(requests).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
});

it('熔断已经打开时思考轮不等待，本轮直接以 circuit_open 结束', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited());
  await expect(runtime.streamSpeech(context)).rejects.toMatchObject({ code: 'transient' });
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(requests).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(1);
  expect(context.replay?.decision).toBeUndefined();
});

it('等待 Retry-After 时取消会立即退出，冷却结束也不再请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(thinking(), rateLimited(), toolResult());
  const controller = new AbortController();
  const result = runtime.decide(context, decisionSchema, controller.signal);
  const reason = new DOMException('Game cancelled', 'AbortError');
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await jest.advanceTimersByTimeAsync(1);
  expect(requests).toHaveLength(2);
  controller.abort(reason);
  await rejected;
  expect(requests).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(2);
  expect(context.replay?.decision).toBeUndefined();
});

it('冷却后的第二次调用仍失败时直接终止，不再次等待或请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(thinking(), rateLimited(), rateLimited());
  const result = runtime.decide(context, decisionSchema);
  const rejected = expect(result).rejects.toMatchObject({
    code: 'transient',
    details: { httpStatus: 429 },
  });
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  await jest.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(3);
});

it('Retry-After 超过现有流式总期限时保留错误，不提前请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(thinking(), rateLimited('6'));
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'transient',
    details: { httpStatus: 429 },
  });
  await jest.advanceTimersByTimeAsync(6000);
  expect(requests).toHaveLength(2);
});

it('半开路由已有探测时立即报告，不额外等待或发出第二个探测', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited());
  await expect(runtime.streamSpeech(context)).rejects.toMatchObject({ code: 'transient' });
  await jest.advanceTimersByTimeAsync(1000);
  const stream = controlledStream();
  responses.push(stream.response, toolResult());
  const probe = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(1);
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(requests).toHaveLength(2);
  stream.send({ content: '探测轮的初判。' }, 'stop');
  stream.end();
  await expect(probe).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
});

it('JSON Schema 输出被截断时进入修正机会', async () => {
  const { runtime, context, responses, requests } = setup('kimi-k3');
  responses.push(
    thinking(),
    completion({ content: '{' }, 'length'),
    completion({ content: JSON.stringify(valid) }),
  );
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(requests[2].messages.at(-1).content).toContain('长度上限');
});

it('GLM 工具调用前被截断应报长度问题，重试耗尽也不保存动作', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, responses, requests } = setup('glm-5.3');
  responses.push(
    thinking(),
    completion({ content: '两', reasoning_content: '分析未完成。' }, 'length', 4096),
    completion({ content: '先', reasoning_content: '分析仍未完成。' }, 'length', 4096),
  );
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'truncated_output', finishReason: 'length', outputTokens: 4096 },
  });
  expect(requests).toHaveLength(3);
  expect(requests[2].messages.at(-1).content).toContain('长度上限');
  expect(requests[1].messages.at(-1).content).toContain('extract 工具');
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'truncated_output',
      outputTokens: 4096,
      elapsedMs: expect.any(Number),
    }),
  );
});

it('工具参数已能解析但结束原因为 length 时，仍需重新取得完整结果', async () => {
  const { runtime, context, responses, requests } = setup('glm-5.3');
  responses.push(thinking(), toolResult(valid, 'length'), toolResult());
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(context.replay?.decision).toEqual(valid.decision);
});

it('保留原始响应后，损坏的工具 JSON 仍按解析错误重试', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, responses, requests } = setup('glm-5.3');
  responses.push(
    thinking(),
    completion(
      {
        content: null,
        tool_calls: [
          {
            id: 'broken-call',
            type: 'function',
            function: { name: 'extract', arguments: '{' },
          },
        ],
      },
      'tool_calls',
    ),
    toolResult(),
  );
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(3);
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'parse_error' }));
});

it('决策和流式请求均不注入 token 上限', async () => {
  const defaults = validateEnv({
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    ARK_API_KEY: 'test-key',
    ARK_BASE_URL: 'https://provider.test/v3',
    ARK_DEFAULT_MODEL: 'glm-5.3',
  });
  const { runtime, context, fetch, requests } = setup('glm-5.3', {
    ...defaults,
    TURN_REFLECTION_MAX_ROUNDS: 0,
  });
  fetch.mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.max_tokens !== undefined && request.max_tokens < 5000)
      return completion({ content: '先' }, 'length', request.max_tokens);
    return request.tools ? toolResult() : streamResponse([{ content: '完整的结论。' }]);
  });
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  await expect(runtime.streamSpeech(context)).resolves.toMatchObject({
    thinking: '完整的结论。',
    content: '完整的结论。',
  });
  expect(requests).toHaveLength(4);
  for (const request of requests) {
    expect(request).not.toHaveProperty('max_tokens');
    expect(request).not.toHaveProperty('max_completion_tokens');
    expect(request).not.toHaveProperty('thinking');
    expect(request.stream).toBe(true);
  }
});

it('供应商的 reasoning_content 不混入应用思考和发言文本', async () => {
  const { runtime, context, responses } = setup('doubao-seed-2.1-turbo');
  responses.push(
    streamResponse([{ reasoning_content: '供应商内部片段' }, { content: '依据公开票型分析。' }]),
    streamResponse([{ content: '请说明投票依据。' }]),
  );
  const onThinking = jest.fn();
  const onContent = jest.fn();
  await expect(runtime.streamSpeech(context, { onThinking, onContent })).resolves.toMatchObject({
    thinking: '依据公开票型分析。',
    content: '请说明投票依据。',
  });
  expect(onThinking.mock.calls.flat().join('')).toBe('依据公开票型分析。');
  expect(onContent.mock.calls.flat().join('')).toBe('请说明投票依据。');
});

it.each(['stop', 'length'])(
  '仅返回 reasoning 的流不能视为有效思考，结束原因为 %s',
  async (finishReason) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { runtime, context, responses, requests } = setup();
    responses.push(streamResponse([{ reasoning_content: '只有供应商内部片段' }], finishReason));
    await expect(runtime.streamSpeech(context)).rejects.toMatchObject({
      code: 'invalid_output',
      details: { reason: finishReason === 'length' ? 'truncated_output' : 'empty_output' },
    });
    expect(requests).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ contentChars: 0, reasoningChars: '只有供应商内部片段'.length }),
    );
  },
);

it('有内容但因 token 上限截断的流不能进入后续发言生成', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, responses, requests } = setup('glm-5.3');
  responses.push(streamResponse([{ content: '还没有说完' }], 'length', 4096));
  await expect(runtime.streamSpeech(context)).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'truncated_output' },
  });
  expect(requests).toHaveLength(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      finishReason: 'length',
      outputTokens: 4096,
    }),
  );
});

it('无响应的发言在期限处取消，日志区分超时并包含玩家与阶段', async () => {
  jest.useFakeTimers();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, fetch } = setup('doubao-seed-evolving', {
    LLM_FIRST_CHUNK_TIMEOUT_MS: 100,
  });
  let requestSignal: AbortSignal | null | undefined;
  fetch.mockImplementation(async (_url, init) => {
    requestSignal = init?.signal;
    return new Promise((_resolve, reject) =>
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true }),
    );
  });
  const result = runtime.streamSpeech(context);
  const rejected = expect(result).rejects.toMatchObject({
    code: 'transient',
    details: { reason: 'timeout', timeoutPhase: 'first_chunk', timeoutMs: 100 },
  });
  await jest.advanceTimersByTimeAsync(101);
  await rejected;
  expect(requestSignal?.aborted).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      modelName: 'doubao-seed-evolving',
      runName: 'speech-thinking-1',
      playerId: 'p',
      reason: 'timeout',
      timeoutPhase: 'first_chunk',
      contentChars: 0,
      receivedChunks: 0,
    }),
  );
});

it.each(['doubao-seed-evolving', 'doubao-seed-2.1-turbo'])(
  '%s 持续输出推理 725 秒后仍可完成分析和正文，不受非流式期限影响',
  async (modelName) => {
    jest.useFakeTimers();
    const defaults = validateEnv({
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      REDIS_URL: 'redis://localhost:6379',
      ARK_API_KEY: 'test-key',
      ARK_BASE_URL: 'https://provider.test/v3',
      ARK_DEFAULT_MODEL: modelName,
    });
    const { runtime, context, responses, requests } = setup(modelName, {
      ...defaults,
      TURN_REFLECTION_MAX_ROUNDS: 0,
    });
    const stream = controlledStream();
    responses.push(stream.response, streamResponse([{ content: '请说明投票理由。' }]));
    const onThinking = jest.fn();
    const result = runtime.streamSpeech(context, { onThinking });
    await jest.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 7; i++) {
      stream.send({ reasoning_content: '继续分析可见信息。' });
      await jest.advanceTimersByTimeAsync(100_000);
    }
    await jest.advanceTimersByTimeAsync(25_000);
    stream.send({ content: '依据公开票型分析。' }, 'stop');
    stream.end();
    await expect(result).resolves.toMatchObject({
      thinking: '依据公开票型分析。',
      content: '请说明投票理由。',
    });
    expect(onThinking.mock.calls.flat().join('')).toBe('依据公开票型分析。');
    expect(requests).toHaveLength(2);
    // 该模型实测支持关闭思维链，发言链路会显式关掉它；但供应商可能静默忽略该开关，
    // 所以本用例仍模拟长时间只吐 reasoning，验证这不会拖垮整轮。
    expect(requests[0].thinking).toEqual({ type: 'disabled' });
  },
);

it('响应头、心跳和空白片段不能解除首包超时', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses } = setup('doubao-seed-evolving', {
    LLM_FIRST_CHUNK_TIMEOUT_MS: 100,
  });
  const stream = controlledStream();
  responses.push(stream.response);
  const result = runtime.streamSpeech(context);
  const rejected = expect(result).rejects.toMatchObject({
    details: { timeoutPhase: 'first_chunk', timeoutMs: 100 },
  });
  await jest.advanceTimersByTimeAsync(40);
  stream.send({});
  stream.heartbeat();
  await jest.advanceTimersByTimeAsync(50);
  stream.send({ content: ' ', reasoning_content: '\n' });
  await jest.advanceTimersByTimeAsync(11);
  await rejected;
  stream.end();
  await jest.advanceTimersByTimeAsync(1);
});

it('有正文后停止产生有效片段会触发 idle，超时后的片段不会继续发布', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('doubao-seed-evolving', {
    LLM_STREAM_IDLE_TIMEOUT_MS: 50,
  });
  const stream = controlledStream();
  responses.push(stream.response);
  const onThinking = jest.fn();
  const result = runtime.streamSpeech(context, { onThinking });
  const rejected = expect(result).rejects.toMatchObject({
    details: { timeoutPhase: 'idle', timeoutMs: 50 },
  });
  await jest.advanceTimersByTimeAsync(1);
  stream.send({ content: '已收到的片段。' });
  await jest.advanceTimersByTimeAsync(40);
  stream.heartbeat();
  await jest.advanceTimersByTimeAsync(11);
  await rejected;
  stream.send({ content: '不应发布的迟到片段。' }, 'stop');
  stream.end();
  await jest.advanceTimersByTimeAsync(1);
  expect(onThinking.mock.calls.flat().join('')).toBe('已收到的片段。');
  expect(requests).toHaveLength(1);
});

it('结构化响应头已返回但正文挂起，仍触发首个有效片段超时', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('kimi-k3', {
    LLM_FIRST_CHUNK_TIMEOUT_MS: 100,
    LLM_CIRCUIT_MIN_SAMPLES: 1,
    LLM_CIRCUIT_COOLDOWN_MS: 6000,
  });
  // 首次超时后 structured 会立刻重试一次，重试同样挂在首包上
  const attempt = hangingStream();
  const retry = hangingStream();
  responses.push(thinking(), attempt.response, retry.response);
  const result = runtime.decide(context, decisionSchema);
  const rejected = expect(result).rejects.toMatchObject({
    code: 'transient',
    details: { reason: 'timeout', timeoutPhase: 'first_chunk' },
  });
  await jest.advanceTimersByTimeAsync(101);
  await jest.advanceTimersByTimeAsync(101);
  await rejected;
  expect(requests).toHaveLength(3);
  attempt.close();
  retry.close();
  await jest.advanceTimersByTimeAsync(1);
});

const replayCases = [
  { name: '查验', schema: buildSeerCheckSchema([1, 2]), action: 'check_identity' },
  { name: '投票', schema: buildVoteSchema([1, 2]), action: 'cast_vote' },
  { name: '狼刀提案', schema: ProposeKillDecisionSchema, action: 'propose_kill' },
];
it.each(
  ['glm-5.3', 'minimax-m3', 'deepseek-v4-pro'].flatMap((modelName) =>
    replayCases.map((item) => ({ modelName, ...item })),
  ),
)(
  '$modelName 的 $name 重放在对象键重排后仍保持思考轮与纠错请求一致',
  async ({ modelName, schema, action }) => {
    const { runtime, context, requests, responses, config } = setup(modelName, {
      TURN_REFLECTION_MAX_ROUNDS: 3,
    });
    const prompts = new PromptService(config as never);
    context.prompts = await prompts.captureSnapshot(PLAYER_TURN_PROMPT_NAMES);
    context.replay = { evidence: [{ sequence: 30 }] };
    const final = { reasoning: '目标2的信息更有价值', decision: { action, targetSeatNo: 2 } };
    // 首轮终稿越界，用同一次纠错重试拿到合法候选
    const invalid = {
      ...final,
      decision:
        action === 'check_identity'
          ? { ...final.decision, action: 'invalid' }
          : {
              ...final.decision,
              targetSeatNo:
                action === 'cast_vote' ? Number.MAX_SAFE_INTEGER + 1 : Number.MIN_SAFE_INTEGER - 1,
            },
    };
    const thinkingTexts = [
      '初判：2号的信息更有价值。',
      '复核：票型支持初判。',
      '复核：3号的发言偏保守。',
      '复核：维持2号。',
    ];
    const feed = () =>
      responses.push(
        ...thinkingTexts.map((text) => streamResponse([{ content: text }])),
        ...(modelName === 'glm-5.3'
          ? [toolResult(invalid), toolResult(final)]
          : [
              completion({ content: JSON.stringify(invalid) }),
              completion({ content: JSON.stringify(final) }),
            ]),
      );
    feed();
    const online = await runtime.decide(context, schema);
    expect(online).toEqual(final);
    expect(context.replay!.thinkingRounds).toEqual(thinkingTexts);
    const source = {
      ...context.replay,
      systemPrompt: context.systemPrompt,
      modelName,
      role: context.player.role,
      scenario: context.scenario,
      prompts: context.prompts,
    };
    const snapshot = JSON.parse(
      JSON.stringify(source, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).toReversed())
          : value,
      ),
    ) as DecisionReplaySnapshot;
    const traces: object[] = [];
    const turns = new PlayerTurnService(
      config as never,
      new ModelCallService(config as never),
      prompts,
      {
        trace: (params: object) => {
          traces.push(params);
          return { callbacks: [] };
        },
      } as never,
    );
    feed();
    const replay = await replayDecision(turns, snapshot, { gameId: 'replay', playerId: 'p' });
    expect(replay).toMatchObject(final);
    expect(replay.thinkingRounds).toEqual(context.replay!.thinkingRounds);
    // 四轮思考各记一次追踪，终稿的初次尝试与纠错重试各记一次
    expect(traces).toHaveLength(6);
    expect(requests).toHaveLength(12);
    expect(requests.slice(6)).toEqual(requests.slice(0, 6));
  },
);
