import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingService } from './embedding.service';
import { MEMORY_EMBEDDING_DIMENSION } from './embedding.service';
import { MemoryService } from './memory.service';

function createMockPrisma() {
  return {
    memory: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as unknown as PrismaService;
}

function createMockEmbeddingService() {
  return {
    model: 'test-embedding-model',
    dimension: MEMORY_EMBEDDING_DIMENSION,
    embedText: jest.fn(),
    embedTexts: jest.fn(),
    assertValidVector: jest.fn((vector: number[]) => {
      if (
        vector.length !== MEMORY_EMBEDDING_DIMENSION ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('invalid embedding');
      }
    }),
  } as unknown as EmbeddingService;
}

describe('MemoryService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;
  let service: MemoryService;

  beforeEach(() => {
    prisma = createMockPrisma();
    embeddingService = createMockEmbeddingService();
    service = new MemoryService(prisma, embeddingService);
  });

  it('语义检索后更新返回记忆的检索次数和时间', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    const rows = [
      {
        id: '3d87b58d-91a4-4eb7-8d12-b191dc38691e',
        type: 'strategy',
        title: '狼人策略',
        content: '优先找到预言家',
        importance: 0.9,
      },
      {
        id: '333cb4ed-76dc-4392-ad6c-ed177638f7d0',
        type: 'persona',
        title: '表达风格',
        content: '先听后说',
        importance: 0.8,
      },
    ];
    (embeddingService.embedText as jest.Mock).mockResolvedValue(vector);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue(rows);

    await expect(
      service.retrieveBySimilarity(
        '5b12e37c-62ca-491a-a46d-a649d08416fd',
        'default',
        '当前应该怎么发言',
      ),
    ).resolves.toEqual(rows);

    expect(prisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: rows.map((row) => row.id) } },
      data: {
        retrievalCount: { increment: 1 },
        lastRetrievedAt: expect.any(Date),
      },
    });
  });

  it('语义检索无结果时不执行热度更新', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await expect(
      service.retrieveBySimilarity('5b12e37c-62ca-491a-a46d-a649d08416fd', 'default', '查询'),
    ).resolves.toEqual([]);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('embedAndStore 在执行 SQL 前校验传入向量', async () => {
    const invalidVector = [0.1, 0.2];

    await expect(
      service.embedAndStore('3d87b58d-91a4-4eb7-8d12-b191dc38691e', invalidVector),
    ).rejects.toThrow('invalid embedding');
    expect(embeddingService.assertValidVector).toHaveBeenCalledWith(invalidVector);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('写入向量时同时固化模型、维度和内容版本', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    (prisma.memory.findUnique as jest.Mock).mockResolvedValue({ content: '稳定内容' });
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    await expect(
      service.embedAndStore('3d87b58d-91a4-4eb7-8d12-b191dc38691e', vector),
    ).resolves.toBeUndefined();

    expect(embeddingService.assertValidVector).toHaveBeenCalledWith(vector);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('内容在生成期间变化时拒绝把旧向量标记为有效', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(0);

    await expect(
      service.embedAndStore('3d87b58d-91a4-4eb7-8d12-b191dc38691e', vector, '生成向量时的内容'),
    ).rejects.toThrow('内容在向量生成期间发生变化');
  });

  it('分批回填可重跑，并只统计已经成功写入的记录', async () => {
    const rows = [
      { id: '3d87b58d-91a4-4eb7-8d12-b191dc38691e', content: '记忆 A' },
      { id: '333cb4ed-76dc-4392-ad6c-ed177638f7d0', content: '记忆 B' },
    ];
    const vectors = rows.map(() => Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1));
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    (embeddingService.embedTexts as jest.Mock).mockResolvedValue(vectors);
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    await expect(service.backfillEmbeddings({ batchSize: 2 })).resolves.toBe(2);
    expect(embeddingService.embedTexts).toHaveBeenCalledWith(['记忆 A', '记忆 B']);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
