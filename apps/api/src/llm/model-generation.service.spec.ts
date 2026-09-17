import { z } from 'zod';
import { ModelGenerationService } from './model-generation.service';
import { ModelCallService } from './model-call.service';
import { testModelCapabilities } from '../testing/model-capabilities.fixture';
import { ChatOpenAI } from '@langchain/openai';
import type { ModelStageState, ModelStageStore } from './model-stage';

const schema = z.object({ score: z.number() });

const mockInvoke = jest.fn();

// 绕过真实 ChatOpenAI：只验证 invoke 返回值的处理分支
jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  })),
}));

function createService(outputs: unknown[]) {
  mockInvoke.mockImplementation(async () => {
    const output = outputs.shift();
    return {
      parsed: output,
      raw: {
        content: output === undefined ? '' : JSON.stringify(output),
        additional_kwargs: {},
        response_metadata: {},
      },
    };
  });
  const values: Record<string, unknown> = {
    JUDGE_MODEL: 'judge-v1',
    ARK_BASE_URL: 'https://judge.test/v1',
    ARK_API_KEY: 'test-key',
  };
  return configuredService(values);
}
function configuredService(values: Record<string, unknown>) {
  const config = {
    get: (key: string) =>
      key === 'MODEL_CAPABILITIES'
        ? testModelCapabilities(String(values.ARK_BASE_URL), ['judge-v1', 'judge-v2'])
        : values[key],
  } as never;
  return new ModelGenerationService(config, new ModelCallService(config), {
    trace: () => ({ callbacks: [], metadata: {}, tags: [], runName: 'judge' }),
  } as never);
}

const baseOptions = {
  schema,
  system: 's',
  user: 'u',
  runName: 'judge-test',
  scenario: 'judge',
  gameId: 'game-1',
  playerId: 'player-1',
};

describe('分析入口复用单次模型调用', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('模型未产出结构化结果时抛出可定位异常，而不是在重试路径崩成 TypeError', async () => {
    const service = createService([undefined, undefined]);

    await expect(service.invoke(baseOptions)).rejects.toMatchObject({ code: 'invalid_output' });
    // 两次空结果明确失败，不会在构造修正消息时崩成 TypeError。
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('凭据准备失败不占预算，修好后可请求，已存结果不再解析凭据', async () => {
    const service = createService([{ score: 80 }]);
    let state: ModelStageState | undefined;
    const stages: ModelStageStore = {
      update: async (_label, change) => (state = change(state)),
    };
    const credentials = jest.fn<Promise<string>, []>().mockRejectedValue(new Error('凭据暂不可用'));
    const access = { baseUrl: 'https://judge.test/v1', apiKey: credentials };
    const request = () =>
      service.structured(
        'judge-v1',
        schema,
        [],
        () => ({ callbacks: [], metadata: {}, tags: [], runName: 'test' }),
        undefined,
        undefined,
        access,
        stages,
        'final',
      );

    await expect(request()).rejects.toThrow('凭据暂不可用');
    expect(state?.attempts).toBe(0);
    expect(state?.failure).toBeUndefined();
    expect(ChatOpenAI).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();

    credentials.mockResolvedValue('rotated-key');
    await expect(request()).resolves.toEqual({ score: 80 });
    const saved = structuredClone(state);
    expect(saved?.attempts).toBe(1);
    expect(ChatOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'rotated-key' }));
    credentials.mockRejectedValue(new Error('已撤销密钥'));
    await expect(request()).resolves.toEqual({ score: 80 });
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(state).toEqual(saved);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('输出非空但不合 schema 时仍走单次重试', async () => {
    const service = createService([{ score: 'bad' }, { score: 80 }]);

    await expect(service.invoke(baseOptions)).resolves.toEqual({
      output: { score: 80 },
      modelName: 'judge-v1',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('invokeReflective 初评一次、反思一次，返回反思修正后的结果', async () => {
    const service = createService([{ score: 90 }, { score: 60 }]);
    const refineUser = jest.fn((first: { score: number }) => `refined:${first.score}`);

    const result = await service.invokeReflective({
      ...baseOptions,
      refineSystem: 'refine-system',
      refineUser,
    });

    expect(result).toEqual({ output: { score: 60 }, modelName: 'judge-v1' });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(refineUser).toHaveBeenCalledWith({ score: 90 });
  });

  it('运行冻结后端点发生变化时，在构造请求前拒绝把最新密钥发往旧端点', async () => {
    const configuration: Record<string, string> = {
      JUDGE_MODEL: 'judge-v1',
      ARK_BASE_URL: 'https://old-model.invalid/v1',
      ARK_API_KEY: 'old-key',
    };
    const service = configuredService(configuration);
    const frozen = service.captureConfiguration();
    configuration.ARK_BASE_URL = 'https://new-model.invalid/v1';
    configuration.ARK_API_KEY = 'new-endpoint-key';
    mockInvoke.mockResolvedValue({
      parsed: { score: 80 },
      raw: { content: '{"score":80}', additional_kwargs: {}, response_metadata: {} },
    });
    await expect(service.invoke({ ...baseOptions, ...frozen })).rejects.toThrow(/端点/);
    expect(ChatOpenAI).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('同端点密钥轮换后沿用冻结模型，并在本次调用读取最新密钥', async () => {
    const configuration: Record<string, string> = {
      JUDGE_MODEL: 'judge-v1',
      ARK_BASE_URL: 'https://same-model.invalid/v1',
      ARK_API_KEY: 'old-key',
    };
    const service = configuredService(configuration);
    const frozen = service.captureConfiguration();
    configuration.JUDGE_MODEL = 'judge-v2';
    configuration.ARK_API_KEY = 'rotated-key';
    mockInvoke.mockResolvedValue({
      parsed: { score: 80 },
      raw: { content: '{"score":80}', additional_kwargs: {}, response_metadata: {} },
    });
    await expect(service.invoke({ ...baseOptions, ...frozen })).resolves.toMatchObject({
      modelName: 'judge-v1',
    });
    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'judge-v1',
        apiKey: 'rotated-key',
        configuration: { baseURL: 'https://same-model.invalid/v1' },
      }),
    );
    expect(frozen).toEqual({ modelName: 'judge-v1', baseUrl: 'https://same-model.invalid/v1' });
  });
});
