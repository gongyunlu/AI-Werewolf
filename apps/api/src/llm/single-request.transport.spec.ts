import { Logger } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ModelCallService } from './model-call.service';

// 保留真实 SDK 和 HTTP 编解码，用实际发出的请求数约束传输层职责。
const endpoint = 'https://provider.test/v3';
const schema = z.object({ target: z.number().int() });
const trace = () => ({ callbacks: [], metadata: {}, tags: [], runName: 'single-request' });
function response(delta: object, finishReason = 'stop') {
  return new Response(
    `data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n` +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function tool(name: string, index: number) {
  return {
    index,
    id: `call-${index}`,
    type: 'function',
    function: { name, arguments: '{"target":2}' },
  };
}

describe('单次模型请求的真实传输边界', () => {
  let calls: ModelCallService;
  let fetch: jest.SpyInstance;
  beforeEach(() => {
    const env: Record<string, unknown> = {
      ARK_BASE_URL: endpoint,
      ARK_API_KEY: 'test-key',
      MODEL_CAPABILITIES: JSON.stringify([
        {
          baseUrl: endpoint,
          model: 'glm-5.3',
          protocol: 'functionCalling',
          allowCodeFence: false,
          disableReasoning: false,
        },
      ]),
      LLM_FIRST_CHUNK_TIMEOUT_MS: 1000,
      LLM_STREAM_MAX_DURATION_MS: 2000,
    };
    calls = new ModelCallService({ get: (name: string) => env[name] } as never);
    fetch = jest.spyOn(globalThis, 'fetch');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('空正文只发一个请求，修正由应用层负责', async () => {
    fetch.mockImplementation(async () => response({ content: '' }));
    await expect(calls.streamText('glm-5.3', [], undefined)).rejects.toMatchObject({
      details: { reason: 'empty_output' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['两个 extract', [tool('extract', 0), tool('extract', 1)]],
    ['extract 与未知工具混合', [tool('extract', 0), tool('other', 1)]],
  ])('%s 不得采用第一份结果', async (_name, tools) => {
    fetch.mockImplementation(async () => response({ tool_calls: tools }, 'tool_calls'));
    await expect(
      calls.structured('glm-5.3', schema, [new HumanMessage('选择目标')], trace),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('未知 endpoint/model 在发送前明确拒绝', async () => {
    fetch.mockImplementation(async () => response({ content: '{"target":2}' }));
    await expect(calls.structured('unregistered-model', schema, [], trace)).rejects.toThrow('能力');
    expect(fetch).not.toHaveBeenCalled();
  });
});
