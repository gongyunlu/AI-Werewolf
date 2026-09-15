import { SCORE_NAMES, LangfuseScoresService } from './langfuse-scores.service';

describe('LangfuseScoresService.configurations', () => {
  const values: Record<string, string> = {
    LANGFUSE_HOST: 'https://langfuse.test',
    LANGFUSE_PUBLIC_KEY: 'pk',
    LANGFUSE_SECRET_KEY: 'sk',
  };

  const service = () => new LangfuseScoresService({ get: (key: string) => values[key] } as never);

  function stubPlatform(list: unknown[]) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) =>
        ({
          ok: true,
          json: async () =>
            init?.body
              ? { id: 'v-created', name: SCORE_NAMES.verdict }
              : { data: list, meta: { totalPages: 1 } },
        }) as Response,
    );
  }

  afterEach(() => jest.restoreAllMocks());

  it('平台回包的 categories 键序与数组顺序都不同时仍复用已有配置', async () => {
    const fetch = stubPlatform([
      { id: 'q1', name: SCORE_NAMES.quality, dataType: 'NUMERIC', minValue: 0, maxValue: 100 },
      {
        id: 'v1',
        name: SCORE_NAMES.verdict,
        dataType: 'CATEGORICAL',
        categories: [
          { value: 2, label: 'good' },
          { value: 0, label: 'poor' },
          { value: 1, label: 'fair' },
        ],
      },
    ]);

    await expect(service().configurations()).resolves.toEqual({
      quality: { id: 'q1', name: SCORE_NAMES.quality },
      verdict: { id: 'v1', name: SCORE_NAMES.verdict },
    });
    // 只回读一次列表，没有为已存在的配置再发创建请求
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('分类集合与领域定义不一致时创建新配置', async () => {
    const fetch = stubPlatform([
      { id: 'q1', name: SCORE_NAMES.quality, dataType: 'NUMERIC', minValue: 0, maxValue: 100 },
      {
        id: 'v0',
        name: SCORE_NAMES.verdict,
        dataType: 'CATEGORICAL',
        categories: [
          { label: 'bad', value: 0 },
          { label: 'good', value: 1 },
        ],
      },
    ]);

    await expect(service().configurations()).resolves.toEqual({
      quality: { id: 'q1', name: SCORE_NAMES.quality },
      verdict: { id: 'v-created', name: SCORE_NAMES.verdict },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
