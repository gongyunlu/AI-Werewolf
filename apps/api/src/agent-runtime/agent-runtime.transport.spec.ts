import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import { Logger } from '@nestjs/common';
import { reviewed } from '../testing/turn-review.fixture';
import { z } from 'zod';
import { AgentRuntimeService } from './agent-runtime.service';
import { PromptService } from '../observability/prompt.service';
import { validateEnv, type Env } from '../config/env.validation';
import { AIMessage } from '@langchain/core/messages';
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
  const history = { load: jest.fn().mockResolvedValue([]), replace: jest.fn() };
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
      history,
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const context = {
    systemPrompt: '按当前可见局面行动。',
    scenario: 'night_action',
    player: { id: 'p', gameId: 'g', modelName, seatNo: 3, role: 'werewolf' },
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
  return { runtime, context, history, requests, responses, fetch, config };
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
    const { runtime, context, responses, requests, history } = setup();
    responses.push(providerStreamError(code, envelope, partial), toolResult());

    await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).resolves.toEqual(valid);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(history.replace).not.toHaveBeenCalled();
  },
);

it.each(['AccountQuotaExceeded', 'AuthenticationError', 'UnknownProviderError'])(
  '未知或需人工处理的流内错误 %s 不按 TooManyRequests 类型笼统重试',
  async (code) => {
    const { runtime, context, responses, requests } = setup();
    responses.push(providerStreamError(code));

    await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ code });
    expect(requests).toHaveLength(1);
  },
);

it.each(['AccountQuotaExceeded', 'insufficient_quota'])(
  'HTTP 429 的明确配额耗尽 %s 不占用临时故障重试',
  async (code) => {
    const { runtime, context, responses, requests } = setup();
    responses.push(
      Response.json({ error: { code, type: code, message: '配额已耗尽' } }, { status: 429 }),
    );

    await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ status: 429 });
    expect(requests).toHaveLength(1);
  },
);

it('持续流内过载耗尽原有一次重试，保留供应商错误码且不伪造 HTTP 状态', async () => {
  const { runtime, context, responses, requests } = setup();
  responses.push(providerStreamError('ServerOverloaded'), providerStreamError('ServerOverloaded'));

  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'transient',
    details: { providerCode: 'ServerOverloaded' },
    cause: { code: 'ServerOverloaded', status: undefined },
  });
  expect(requests).toHaveLength(2);
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

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each([
  ['glm-5.3', 'review'],
  ['kimi-k3', 'review'],
  ['glm-5.3', 'revision'],
  ['kimi-k3', 'revision'],
])('%s 的结构化 %s 持续推理超过 5 分钟仍可完成，且只返回完整候选', async (modelName, stage) => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup(modelName, {
    TURN_REFLECTION_MAX_ROUNDS: 2,
    LLM_CALL_TIMEOUT_MS: 300_000,
    LLM_FIRST_CHUNK_TIMEOUT_MS: 300_000,
    LLM_STREAM_IDLE_TIMEOUT_MS: 300_000,
    LLM_STREAM_MAX_DURATION_MS: 900_000,
  });
  const response = (output: unknown) =>
    modelName.startsWith('glm')
      ? toolResult(output)
      : completion({ content: JSON.stringify(output) });
  responses.push(response(valid));
  if (stage === 'revision')
    responses.push(
      response(
        reviewed([{ kind: 'action_reason', explanation: '补充理由', evidenceSequences: [] }]),
      ),
    );
  const stream = controlledStream();
  responses.push(stream.response);
  if (stage === 'revision') responses.push(response(reviewed()));
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
  const revised = { ...valid, reasoning: '保留人数继续投票。' };
  const output = JSON.stringify(stage === 'review' ? reviewed() : revised);
  stream.send(
    modelName.startsWith('glm')
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call-review',
              type: 'function',
              function: { name: 'extract', arguments: output },
            },
          ],
        }
      : { content: output },
    modelName.startsWith('glm') ? 'tool_calls' : 'stop',
  );
  stream.end();
  await expect(result).resolves.toEqual(stage === 'review' ? valid : revised);
  expect(requests).toHaveLength(stage === 'review' ? 2 : 4);
  for (const request of requests) expect(request.stream).toBe(true);
});

it('工具参数碎片维持进度，但在完整流结束前不会生成待提交动作', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses } = setup('glm-5.3', { LLM_STREAM_IDLE_TIMEOUT_MS: 50 });
  const stream = controlledStream();
  responses.push(stream.response);
  const result = runtime.decide(context, decisionSchema, undefined, 'g/p');
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
    expect(context.pendingHistory).toBeUndefined();
  }
  stream.send({}, 'tool_calls');
  stream.end();
  await expect(result).resolves.toEqual(valid);
  expect(context.pendingHistory?.decision).toEqual(valid.decision);
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
    const stream = controlledStream();
    responses.push(stream.response);
    const result = runtime.decide(context, decisionSchema);
    const rejected = expect(result).rejects.toMatchObject({
      code: 'transient',
      details: { reason: 'timeout', timeoutPhase: phase },
    });
    await jest.advanceTimersByTimeAsync(1);
    if (phase !== 'first_chunk') stream.send({ reasoning_content: '核对证据' });
    else
      stream.send({
        tool_calls: [
          {
            index: 0,
            id: 'call-empty',
            type: 'function',
            function: { name: 'extract', arguments: '' },
          },
        ],
      });
    await jest.advanceTimersByTimeAsync(60);
    stream.heartbeat();
    stream.send({ content: ' ', reasoning_content: '\n' });
    if (phase === 'total') stream.send({ reasoning_content: '仍在分析' });
    await jest.advanceTimersByTimeAsync(42);
    await rejected;
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutPhase: phase,
        receivedChunks: expect.any(Number),
        toolArgumentChars: 0,
      }),
    );
    expect(context.pendingHistory).toBeUndefined();
    expect(requests).toHaveLength(1);
    stream.end();
    await jest.advanceTimersByTimeAsync(1);
  },
);

it('复核流收到推理后被取消，不重试、不把初稿作为通过复核的动作返回', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    TURN_REFLECTION_MAX_ROUNDS: 1,
  });
  const stream = controlledStream();
  responses.push(toolResult(), stream.response);
  const controller = new AbortController();
  const result = runtime.decide(context, decisionSchema, controller.signal, 'g/p');
  const reason = new Error('对局已取消');
  const rejected = expect(result).rejects.toBe(reason);
  await jest.advanceTimersByTimeAsync(1);
  stream.send({ reasoning_content: '复核中' });
  await jest.advanceTimersByTimeAsync(1);
  controller.abort(reason);
  await rejected;
  expect(requests).toHaveLength(2);
  expect(context.pendingHistory).toBeUndefined();
  stream.end();
});

it('工具协议未调用工具时经过真实 SDK 的空结果会重试，成功后只保留最终待提交候选', async () => {
  const { runtime, context, history, requests, responses } = setup();
  responses.push(completion({ content: '{"reasoning":"继续游戏","action":"hold"}' }), toolResult());
  await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
  expect(requests[0].tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
  expect(requests[0].messages.at(-1).content).toContain('extract 工具');
  expect(requests[1].messages.at(-1).content).toContain('extract 工具');
  expect(requests[1].messages.at(-1).content).toContain(
    JSON.stringify({ content: '{"reasoning":"继续游戏","action":"hold"}', toolCalls: [] }),
  );
  expect(history.replace).not.toHaveBeenCalled();
  expect(context.pendingHistory?.decision).toEqual(valid.decision);
});

it.each(['minimax-m3', 'glm-5.3', 'doubao-seed-2.1-turbo'])(
  '%s 的决策、复核及修订在首次请求使用一致的结果提交协议',
  async (modelName) => {
    const { runtime, context, responses, requests } = setup(modelName, {
      TURN_REFLECTION_MAX_ROUNDS: 2,
    });
    const review = reviewed([
      { kind: 'action_reason', explanation: '需要明确最终选择', evidenceSequences: [] },
    ]);
    const revised = { ...valid, reasoning: '最终选择hold，保留发言机会。' };
    for (const output of [valid, review, revised, reviewed()])
      responses.push(
        modelName !== 'glm-5.3'
          ? completion({
              content:
                modelName === 'minimax-m3'
                  ? `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``
                  : JSON.stringify(output),
            })
          : toolResult(output),
      );
    context.game = { id: 'g' } as typeof context.game;
    context.replay = { evidence: [] } as typeof context.replay;
    await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(revised);
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      if (modelName !== 'glm-5.3') {
        expect(request).not.toHaveProperty('tools');
        expect(request.messages.at(-1).content).not.toContain('extract 工具');
        expect(request.response_format.type).toBe(
          modelName === 'minimax-m3' ? 'json_object' : 'json_schema',
        );
        if (modelName === 'minimax-m3')
          expect(request.messages.at(-1).content).toContain('"required"');
      } else {
        expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'extract' } });
        expect(request.messages.at(-1).content).toContain('extract 工具');
      }
      expect(request).not.toHaveProperty('max_tokens');
      expect(request).not.toHaveProperty('max_completion_tokens');
    }
  },
);

it('工具字段不满足 schema 时同样只有一次修正机会', async () => {
  const { runtime, context, responses, requests } = setup();
  responses.push(toolResult({ ...valid, reasoning: '' }), toolResult());
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1).content).toContain('"path":["reasoning"]');
});

it.each(['explanation', 'issues'])('工具复核的 %s 结构错误不能被当成通过', async (field) => {
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    TURN_REFLECTION_MAX_ROUNDS: 2,
  });
  const complete = reviewed();
  const invalid =
    field === 'issues'
      ? { ...complete, issues: {} }
      : { issues: [{ kind: 'timeline', evidenceSequences: [] }] };
  responses.push(toolResult(), toolResult(invalid), toolResult(invalid));
  context.game = { id: 'g' } as typeof context.game;
  context.replay = { evidence: [] } as typeof context.replay;
  await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'schema_validation' },
  });
  expect(requests).toHaveLength(3);
  expect(requests[2].messages.at(-1).content).toContain(
    JSON.stringify(field === 'issues' ? ['issues'] : ['issues', 0, 'explanation']),
  );
  expect(context.replay?.reflection).toBeUndefined();
  expect(context.pendingHistory).toBeUndefined();
});

it('真实工具响应的原句定位错误会反馈具体替换项，不丢成 parsed=null 的泛化错误', async () => {
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    TURN_REFLECTION_MAX_ROUNDS: 2,
  });
  context.replay = { evidence: [{ sequence: 30 }] };
  responses.push(
    streamResponse([{ content: '基于当前日期发言' }]),
    streamResponse([{ content: '昨天4号发言。首夜4号金水。' }]),
    toolResult(reviewed([{ kind: 'timeline', explanation: '应为今天', evidenceSequences: [30] }])),
    toolResult({
      reasoning: '修正日期',
      contentEdits: [{ before: '不存在的原文', after: '今天' }],
    }),
    toolResult({ reasoning: '修正日期', contentEdits: [{ before: '昨天', after: '今天' }] }),
    toolResult(reviewed()),
  );
  const onContent = jest.fn();
  await expect(runtime.streamSpeech(context, 'g/p', { onContent })).resolves.toMatchObject({
    content: '今天4号发言。首夜4号金水。',
  });
  expect(requests).toHaveLength(6);
  expect(requests[4].messages.at(-1).content).toContain('contentEdits[0].before');
  expect(requests[4].messages.at(-1).content).toContain('逐字保留');
  expect(onContent.mock.calls.flat().join('')).toBe('今天4号发言。首夜4号金水。');
});

it('连续两次漏掉工具调用后抛出模型错误，不把文本改造成合法动作', async () => {
  const { runtime, context, history, responses, requests } = setup();
  responses.push(completion({ content: 'hold' }), completion({ content: 'hold' }));
  await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'schema_validation' },
  });
  expect(requests).toHaveLength(2);
  expect(history.replace).not.toHaveBeenCalled();
});

it('JSON Schema 模型遇到不完整 JSON 后按原协议重试', async () => {
  const { runtime, context, responses, requests } = setup('kimi-k3');
  responses.push(completion({ content: '{' }), completion({ content: JSON.stringify(valid) }));
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
  expect(requests[1].response_format.type).toBe('json_schema');
  expect(requests[1].messages.at(-1).content).toContain('JSON Schema');
  expect(requests[1].messages.at(-1).content).toContain(
    JSON.stringify({ content: '{', toolCalls: [] }),
  );
});

it.each(['explanation', 'issues'])(
  '复核的 %s 错误响应与字段位置一同反馈，修正后才通过',
  async (field) => {
    const { runtime, context, responses, requests } = setup('glm-5.3', {
      TURN_REFLECTION_MAX_ROUNDS: 2,
    });
    const complete = reviewed();
    const invalid =
      field === 'issues'
        ? { ...complete, issues: {} }
        : { issues: [{ kind: 'timeline', evidenceSequences: [] }] };
    responses.push(
      toolResult(),
      completion(
        {
          content: null,
          reasoning_content: '不应回传的供应商内部推理',
          tool_calls: [
            {
              id: 'invalid-review',
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
      toolResult(complete),
    );
    context.game = { id: 'g' } as typeof context.game;
    context.replay = { evidence: [] } as typeof context.replay;
    await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).resolves.toEqual(valid);
    expect(requests).toHaveLength(3);
    const feedback = requests[2].messages.at(-1).content;
    expect(feedback).toContain(
      JSON.stringify(field === 'issues' ? ['issues'] : ['issues', 0, 'explanation']),
    );
    const previous = JSON.parse(feedback.slice(feedback.lastIndexOf('\n') + 1));
    expect(previous.toolCalls[0].function.arguments).toBe(JSON.stringify(invalid));
    expect(feedback).not.toContain('不应回传的供应商内部推理');
    // 错误工具请求作为数据传递，不生成未配对的 assistant/tool 消息。
    expect(requests[2].messages.slice(requests[1].messages.length)).toEqual([
      { role: 'user', content: feedback },
    ]);
    expect(context.replay?.reflection).toMatchObject({ status: 'passed' });
    expect(context.pendingHistory?.decision).toEqual(valid.decision);
  },
);

it.each(['glm-5.3', 'kimi-k3', 'minimax-m3'])(
  '%s 不能把流解析器自动补齐的 JSON 当成完整输出',
  async (modelName) => {
    const { runtime, context, responses, requests } = setup(modelName);
    const content = JSON.stringify(valid).slice(0, -1);
    responses.push(
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
    expect(requests).toHaveLength(2);
  },
);

it.each([true, false])('MiniMax 文本复核仍严格校验数组，重试修正=%s', async (corrected) => {
  const { runtime, context, responses, requests } = setup('minimax-m3', {
    TURN_REFLECTION_MAX_ROUNDS: 2,
  });
  const complete = reviewed();
  const invalid = { ...complete, issues: {} };
  const content = `\`\`\`json\n${JSON.stringify(invalid)}\n\`\`\``;
  responses.push(
    completion({ content: JSON.stringify(valid) }),
    completion({ content }),
    completion({ content: JSON.stringify(corrected ? complete : invalid) }),
  );
  context.game = { id: 'g' } as typeof context.game;
  context.replay = { evidence: [] } as typeof context.replay;
  const result = runtime.decide(context, decisionSchema, undefined, 'g/p');
  if (corrected) {
    await expect(result).resolves.toEqual(valid);
    expect(context.replay?.reflection).toMatchObject({ status: 'passed' });
  } else {
    await expect(result).rejects.toMatchObject({ code: 'invalid_output' });
    expect(context.replay?.reflection).toBeUndefined();
    expect(context.pendingHistory).toBeUndefined();
  }
  expect(requests).toHaveLength(3);
  expect(requests[2].response_format).toEqual({ type: 'json_object' });
  expect(requests[2]).not.toHaveProperty('tools');
  const feedback = requests[2].messages.at(-1).content;
  expect(feedback).toContain('"path":["issues"]');
  expect(feedback).toContain(JSON.stringify({ content, toolCalls: [] }));
});

it.each([
  { status: 400, message: 'InvalidParameter', type: 'invalid_request_error' },
  { status: 401, message: 'Unauthorized', type: 'authentication_error' },
])('HTTP $status 不进入模型修正重试', async ({ status, message, type }) => {
  const { runtime, context, responses, requests } = setup();
  responses.push(Response.json({ error: { message, type } }, { status }));
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({ status });
  expect(requests).toHaveLength(1);
});

it('Retry-After 冷却结束前不发请求，结束后只重试一次并成功', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited(), toolResult());
  const result = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(999);
  expect(requests).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
});

it('首次遇到已有的未来熔断时间也使用一次等待重试', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited(), toolResult());
  await expect(runtime.streamSpeech(context, 'g/p')).rejects.toMatchObject({ code: 'transient' });
  const result = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(999);
  expect(requests).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
});

it('等待 Retry-After 时取消会立即退出，冷却结束也不再请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests, history } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited(), toolResult());
  const controller = new AbortController();
  const result = runtime.decide(context, decisionSchema, controller.signal, 'g/p');
  const reason = new DOMException('Game cancelled', 'AbortError');
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await jest.advanceTimersByTimeAsync(1);
  expect(requests).toHaveLength(1);
  controller.abort(reason);
  await rejected;
  expect(requests).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(1);
  expect(history.replace).not.toHaveBeenCalled();
  expect(context.pendingHistory).toBeUndefined();
});

it('冷却后的第二次调用仍失败时直接终止，不再次等待或请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited(), rateLimited());
  const result = runtime.decide(context, decisionSchema);
  const rejected = expect(result).rejects.toMatchObject({
    code: 'transient',
    details: { httpStatus: 429 },
  });
  await jest.advanceTimersByTimeAsync(1000);
  await rejected;
  await jest.advanceTimersByTimeAsync(1000);
  expect(requests).toHaveLength(2);
});

it('Retry-After 超过现有流式总期限时保留错误，不提前请求', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited('6'));
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'transient',
    details: { httpStatus: 429 },
  });
  await jest.advanceTimersByTimeAsync(6000);
  expect(requests).toHaveLength(1);
});

it('半开路由已有探测时立即报告，不额外等待或发出第二个探测', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses, requests } = setup('glm-5.3', {
    LLM_CIRCUIT_COOLDOWN_MS: 1000,
  });
  responses.push(rateLimited());
  await expect(runtime.streamSpeech(context, 'g/p')).rejects.toMatchObject({ code: 'transient' });
  await jest.advanceTimersByTimeAsync(1000);
  const stream = controlledStream();
  responses.push(stream.response);
  const probe = runtime.decide(context, decisionSchema);
  await jest.advanceTimersByTimeAsync(1);
  await expect(runtime.decide(context, decisionSchema)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(requests).toHaveLength(2);
  stream.send(
    {
      tool_calls: [
        {
          index: 0,
          id: 'probe',
          type: 'function',
          function: { name: 'extract', arguments: JSON.stringify(valid) },
        },
      ],
    },
    'tool_calls',
  );
  stream.end();
  await expect(probe).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
});

it('JSON Schema 输出被截断时进入修正机会', async () => {
  const { runtime, context, responses, requests } = setup('kimi-k3');
  responses.push(
    completion({ content: '{' }, 'length'),
    completion({ content: JSON.stringify(valid) }),
  );
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1).content).toContain('长度上限');
});

it('GLM 工具调用前被截断应报长度问题，重试耗尽也不保存动作', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, responses, requests, history } = setup('glm-5.3');
  responses.push(
    completion({ content: '两', reasoning_content: '分析未完成。' }, 'length', 4096),
    completion({ content: '先', reasoning_content: '分析仍未完成。' }, 'length', 4096),
  );
  await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).rejects.toMatchObject({
    code: 'invalid_output',
    details: { reason: 'truncated_output', finishReason: 'length', outputTokens: 4096 },
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1).content).toContain('长度上限');
  expect(requests[1].messages.at(-1).content).toContain('extract 工具');
  expect(history.replace).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'truncated_output',
      outputTokens: 4096,
      elapsedMs: expect.any(Number),
    }),
  );
});

it('工具参数已能解析但结束原因为 length 时，仍需重新取得完整结果', async () => {
  const { runtime, context, responses, requests, history } = setup('glm-5.3');
  responses.push(toolResult(valid, 'length'), toolResult());
  await expect(runtime.decide(context, decisionSchema, undefined, 'g/p')).resolves.toEqual(valid);
  expect(requests).toHaveLength(2);
  expect(history.replace).not.toHaveBeenCalled();
  expect(context.pendingHistory?.decision).toEqual(valid.decision);
});

it('保留原始响应后，损坏的工具 JSON 仍按解析错误重试', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const { runtime, context, responses, requests } = setup('glm-5.3');
  responses.push(
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
  expect(requests).toHaveLength(2);
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
  const { runtime, context, fetch, requests } = setup('glm-5.3', defaults);
  fetch.mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    if (request.max_tokens !== undefined && request.max_tokens < 5000)
      return completion({ content: '先' }, 'length', request.max_tokens);
    if (request.tools?.[0]?.function?.parameters?.properties?.issues) return toolResult(reviewed());
    return request.tools ? toolResult() : streamResponse([{ content: '完整的结论。' }]);
  });
  await expect(runtime.decide(context, decisionSchema)).resolves.toEqual(valid);
  await expect(runtime.streamSpeech(context, 'g/p')).resolves.toMatchObject({
    thinking: '完整的结论。',
    content: '完整的结论。',
  });
  expect(requests).toHaveLength(5);
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
  await expect(
    runtime.streamSpeech(context, 'g/p', { onThinking, onContent }),
  ).resolves.toMatchObject({
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
    await expect(runtime.streamSpeech(context, 'g/p')).rejects.toMatchObject({
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
  await expect(runtime.streamSpeech(context, 'g/p')).rejects.toMatchObject({
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
  const result = runtime.streamSpeech(context, 'g/p');
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
      runName: 'speech-thinking',
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
    const result = runtime.streamSpeech(context, 'g/p', { onThinking });
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
    expect(requests[0].thinking).toBeUndefined();
  },
);

it('响应头、心跳和空白片段不能解除首包超时', async () => {
  jest.useFakeTimers();
  const { runtime, context, responses } = setup('doubao-seed-evolving', {
    LLM_FIRST_CHUNK_TIMEOUT_MS: 100,
  });
  const stream = controlledStream();
  responses.push(stream.response);
  const result = runtime.streamSpeech(context, 'g/p');
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
  const result = runtime.streamSpeech(context, 'g/p', { onThinking });
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
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  responses.push(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sink = controller;
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  const result = runtime.decide(context, decisionSchema);
  const rejected = expect(result).rejects.toMatchObject({
    code: 'transient',
    details: { reason: 'timeout', timeoutPhase: 'first_chunk' },
  });
  await jest.advanceTimersByTimeAsync(101);
  await rejected;
  expect(requests).toHaveLength(1);
  sink.close();
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
  '$modelName 的 $name 重放在对象键重排后仍保持纠错及反思请求一致',
  async ({ modelName, schema, action }) => {
    const { runtime, context, history, requests, responses, config } = setup(modelName, {
      TURN_REFLECTION_MAX_ROUNDS: 3,
    });
    const prompts = new PromptService(config as never);
    context.prompts = await prompts.captureSnapshot(PLAYER_TURN_PROMPT_NAMES);
    context.replay = { evidence: [{ sequence: 30 }] };
    history.load.mockResolvedValue([new AIMessage('本人此前已提交：继续隐藏身份。')]);
    const draft = { reasoning: '目标2的信息更有价值', decision: { action, targetSeatNo: 1 } };
    const final = { reasoning: '目标2的信息更有价值', decision: { action, targetSeatNo: 2 } };
    const outputs = [
      {
        ...draft,
        decision:
          action === 'check_identity'
            ? { ...draft.decision, action: 'invalid' }
            : {
                ...draft.decision,
                targetSeatNo:
                  action === 'cast_vote'
                    ? Number.MAX_SAFE_INTEGER + 1
                    : Number.MIN_SAFE_INTEGER - 1,
              },
      },
      { ...draft, extra: '不会保留', decision: { ...draft.decision, extra: '不会保留' } },
      reviewed([{ kind: 'action_reason', explanation: '动作与理由相反', evidenceSequences: [30] }]),
      final,
      reviewed(),
    ];
    const feed = () =>
      responses.push(
        ...outputs.map((output) =>
          modelName === 'glm-5.3'
            ? toolResult(output)
            : completion({ content: JSON.stringify(output) }),
        ),
      );
    feed();
    const online = await runtime.decide(context, schema, undefined, 'thread');
    expect(online).toEqual(final);
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
    expect(replay.reflection).toEqual(context.replay.reflection);
    expect(traces).toHaveLength(5);
    expect(requests).toHaveLength(10);
    expect(requests.slice(5)).toEqual(requests.slice(0, 5));
    expect(history.replace).not.toHaveBeenCalled();
  },
);
