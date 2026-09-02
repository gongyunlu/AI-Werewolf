import { z } from 'zod';
import { StructuredLlmService } from './structured-llm.service';

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
});
