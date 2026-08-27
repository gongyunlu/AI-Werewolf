import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { EmbeddingService, MEMORY_EMBEDDING_DIMENSION } from './embedding.service';

const mockEmbedQuery = jest.fn();
const mockEmbedDocuments = jest.fn();

jest.mock('@langchain/openai', () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedQuery: mockEmbedQuery,
    embedDocuments: mockEmbedDocuments,
  })),
}));

const createVector = (value = 0.1): number[] =>
  Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(value);

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    jest.clearAllMocks();
    const config = {
      get: jest.fn((key: keyof Env) => {
        const values: Partial<Env> = {
          ARK_API_KEY: 'test-key',
          ARK_EMBEDDING_MODEL: 'test-embedding-model',
          ARK_BASE_URL: 'https://example.com',
        };
        return values[key];
      }),
    } as unknown as ConfigService<Env, true>;
    service = new EmbeddingService(config);
  });

  it('返回 2048 维有限数值向量', async () => {
    const vector = createVector();
    mockEmbedQuery.mockResolvedValue(vector);

    await expect(service.embedText('测试记忆')).resolves.toBe(vector);
  });

  it('拒绝维度与数据库契约不符的模型输出', async () => {
    mockEmbedQuery.mockResolvedValue(Array<number>(64).fill(0.1));

    await expect(service.embedText('测试记忆')).rejects.toThrow(
      'Embedding 向量维度无效：期望 2048 维，实际 64 维',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('拒绝非有限数值 %s', async (value) => {
    const vector = createVector();
    vector[7] = value;
    mockEmbedQuery.mockResolvedValue(vector);

    await expect(service.embedText('测试记忆')).rejects.toThrow(
      'Embedding 向量数值无效：索引 7 不是有限数值',
    );
  });

  it('校验批量响应的向量数量', async () => {
    mockEmbedDocuments.mockResolvedValue([createVector()]);

    await expect(service.embedTexts(['记忆 A', '记忆 B'])).rejects.toThrow(
      'Embedding 服务返回数量异常：期望 2 条，实际 1 条',
    );
  });
});
