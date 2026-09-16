import { EmbeddingService, MEMORY_EMBEDDING_DIMENSION } from './embedding.service';
const vector = () => Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
let service: EmbeddingService;
let fetch: jest.SpyInstance;
beforeEach(() => {
  const env: Record<string, unknown> = {
    ARK_API_KEY: 'test-key',
    ARK_EMBEDDING_MODEL: 'embedding',
    ARK_BASE_URL: 'https://embedding.test/v1',
    LLM_CALL_TIMEOUT_MS: 500,
  };
  fetch = jest.spyOn(globalThis, 'fetch');
  service = new EmbeddingService({ get: (key: string) => env[key] } as never);
});
afterEach(() => jest.restoreAllMocks());
function respond(vectors: number[][]) {
  fetch.mockImplementation(async () =>
    Response.json({
      data: vectors.map((embedding, index) => ({ index, embedding })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
  );
}
it('真实 SDK 返回 2048 维有限向量', async () => {
  respond([vector()]);
  await expect(service.embedText('测试记忆')).resolves.toEqual(vector());
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('错维度与错数量均明确失败', async () => {
  respond([[0.1]]);
  await expect(service.embedText('测试记忆')).rejects.toThrow('维度无效');
  respond([vector()]);
  await expect(service.embedTexts(['甲', '乙'])).rejects.toThrow('数量异常');
});
it.each([NaN, Infinity])('拒绝非有限数值 %s', (value) => {
  const values = vector();
  values[7] = value;
  expect(() => service.assertValidVector(values)).toThrow('数值无效');
});
it('429 不触发 SDK 或 AsyncCaller 隐藏重试', async () => {
  fetch.mockImplementation(async () =>
    Response.json(
      { error: { message: 'rate limited', type: 'rate_limit_error' } },
      { status: 429 },
    ),
  );
  await expect(service.embedText('测试记忆')).rejects.toMatchObject({ code: 'transient' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('取消传到底层 HTTP 请求，不只停止外层等待', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  fetch.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), {
          once: true,
        });
        controller.abort(new Error('停止向量化'));
      }),
  );
  await expect(service.embedText('测试记忆', controller.signal)).rejects.toThrow('停止向量化');
  expect(requestSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('分批保持单次最多十条，错误索引不能错绑向量', async () => {
  fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.input.length).toBeLessThanOrEqual(10);
    return Response.json({
      data: body.input.map((_text: string, index: number) => ({ index, embedding: vector() })),
    });
  });
  expect(await service.embedTexts(Array<string>(11).fill('测试'))).toHaveLength(11);
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockImplementation(async () =>
    Response.json({ data: [{ index: 1, embedding: vector() }] }),
  );
  await expect(service.embedText('错位')).rejects.toThrow('索引');
});
