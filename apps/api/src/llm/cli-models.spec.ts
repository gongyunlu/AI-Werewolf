import { z } from 'zod';
import { createCliModels } from './cli-models';
import { testModelCapabilities } from '../testing/model-capabilities.fixture';

it('CLI 解析环境中的数字期限，沿用统一真实 SDK 且不产生隐藏重试', async () => {
  jest.replaceProperty(process, 'env', {
    ARK_API_KEY: 'test-key',
    ARK_BASE_URL: 'https://cli.test/v1',
    ARK_DEFAULT_MODEL: 'script',
    MODEL_CAPABILITIES: testModelCapabilities('https://cli.test/v1', ['script']),
    CLI_MAX_DURATION_MS: '10000',
    LLM_STREAM_MAX_DURATION_MS: '2000',
    LANGFUSE_PUBLIC_KEY: '',
    LANGFUSE_SECRET_KEY: '',
  });
  const timeout = jest.spyOn(AbortSignal, 'timeout');
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async () =>
        new Response(
          `data: ${JSON.stringify({ id: 'cli', object: 'chat.completion.chunk', created: 1, model: 'script', choices: [{ index: 0, delta: { content: '{"action":"hold"}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
  const models = createCliModels();
  try {
    await expect(
      models.generations.invoke({
        schema: z.object({ action: z.literal('hold') }),
        system: '固定系统输入',
        user: '固定请求',
        runName: 'cli',
        scenario: 'knowledge',
        gameId: 'cli',
        playerId: 'chunk',
        signal: models.signal,
      }),
    ).resolves.toMatchObject({ output: { action: 'hold' } });
    expect(timeout).toHaveBeenCalledWith(10000);
    expect(timeout.mock.calls.every(([ms]) => typeof ms === 'number' && Number.isFinite(ms))).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await models.close();
    jest.restoreAllMocks();
  }
});
