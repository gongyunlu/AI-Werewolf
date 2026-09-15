import { z } from 'zod';
import { StructuredLlmService } from './structured-llm.service';
import { ChatOpenAI } from '@langchain/openai';

const schema = z.object({ score: z.number() });

const mockInvoke = jest.fn();

// 绕过真实 ChatOpenAI：只验证 invoke 返回值的处理分支
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
  })),
}));

function createService(outputs: unknown[]) {
  mockInvoke.mockImplementation(async () => outputs.shift());
  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'JUDGE_MODEL') return 'glm-4';
      return 'stub';
    }),
  };
  const langfuse = { trace: jest.fn().mockReturnValue({}) };
  return new StructuredLlmService(configService as never, langfuse as never);
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

describe('StructuredLlmService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('模型未产出结构化结果时抛出可定位异常，而不是在重试路径崩成 TypeError', async () => {
    const service = createService([undefined]);

    await expect(service.invoke(baseOptions)).rejects.toThrow('未返回结构化输出');
    // 不得进入重试：重试消息里 JSON.stringify(undefined) 会让 AIMessage 构造函数崩溃
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('输出非空但不合 schema 时仍走单次重试', async () => {
    const service = createService([{ score: 'bad' }, { score: 80 }]);

    await expect(service.invoke(baseOptions)).resolves.toEqual({
      output: { score: 80 },
      modelName: 'glm-4',
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

    expect(result).toEqual({ output: { score: 60 }, modelName: 'glm-4' });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(refineUser).toHaveBeenCalledWith({ score: 90 });
  });

  it('运行冻结后端点发生变化时，在构造请求前拒绝把最新密钥发往旧端点', async () => {
    const configuration: Record<string, string> = {
      JUDGE_MODEL: 'judge-v1',
      ARK_BASE_URL: 'https://old-model.invalid/v1',
      ARK_API_KEY: 'old-key',
    };
    const service = new StructuredLlmService(
      { get: (key: string) => configuration[key] } as never,
      { trace: jest.fn(() => ({})) } as never,
    );
    const frozen = service.captureConfiguration();
    configuration.ARK_BASE_URL = 'https://new-model.invalid/v1';
    configuration.ARK_API_KEY = 'new-endpoint-key';
    mockInvoke.mockResolvedValue({ score: 80 });
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
    const service = new StructuredLlmService(
      { get: (key: string) => configuration[key] } as never,
      { trace: jest.fn(() => ({})) } as never,
    );
    const frozen = service.captureConfiguration();
    configuration.JUDGE_MODEL = 'judge-v2';
    configuration.ARK_API_KEY = 'rotated-key';
    mockInvoke.mockResolvedValue({ score: 80 });
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
