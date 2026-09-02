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
    memoryUsage: {
      createMany: jest.fn(),
      findMany: jest.fn(),
    },
    decisionJudgment: { groupBy: jest.fn() },
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

type SqlFragment = { strings: string[]; values: unknown[] };

/** 从 $queryRaw 的 tagged-template mock 调用参数里提取 Prisma.sql 片段（值里带 strings/values 的对象） */
function sqlFragments(call: unknown[]): SqlFragment[] {
  return call
    .slice(1)
    .filter(
      (value): value is SqlFragment =>
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as SqlFragment).strings) &&
        Array.isArray((value as SqlFragment).values),
    );
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
        similarity: 0.9,
      },
      {
        id: '333cb4ed-76dc-4392-ad6c-ed177638f7d0',
        type: 'persona',
        title: '表达风格',
        content: '先听后说',
        importance: 0.8,
        similarity: 0.8,
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

  it('传入 role/scenario 时在 SQL 层硬过滤', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    (embeddingService.embedText as jest.Mock).mockResolvedValue(vector);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.retrieveBySimilarity('5b12e37c-62ca-491a-a46d-a649d08416fd', 'default', '查询', {
      role: 'seer',
      scenario: 'vote',
    });

    const fragments = sqlFragments((prisma.$queryRaw as jest.Mock).mock.calls[0]);
    const roleFragment = fragments.find((fragment) =>
      fragment.strings.join('').includes("metadata->>'role'"),
    );
    const scenarioFragment = fragments.find((fragment) =>
      fragment.strings.join('').includes("metadata->>'scenario'"),
    );

    expect(roleFragment?.values).toContain('seer');
    expect(scenarioFragment?.values).toContain('vote');
    expect(roleFragment?.strings.join('')).not.toContain('IS NULL');
    expect(scenarioFragment?.strings.join('')).not.toContain('IS NULL');
  });

  it('只传 role 时不加 scenario 硬过滤', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    (embeddingService.embedText as jest.Mock).mockResolvedValue(vector);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.retrieveBySimilarity('5b12e37c-62ca-491a-a46d-a649d08416fd', 'default', '查询', {
      role: 'seer',
    });

    const fragments = sqlFragments((prisma.$queryRaw as jest.Mock).mock.calls[0]);
    expect(
      fragments.some((fragment) => fragment.strings.join('').includes("metadata->>'role'")),
    ).toBe(true);
    expect(
      fragments.some((fragment) => fragment.strings.join('').includes("metadata->>'scenario'")),
    ).toBe(false);
  });

  it('不传 role/scenario 时硬过滤片段不出现', async () => {
    const vector = Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1);
    (embeddingService.embedText as jest.Mock).mockResolvedValue(vector);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.retrieveBySimilarity('5b12e37c-62ca-491a-a46d-a649d08416fd', 'default', '查询');

    const fragments = sqlFragments((prisma.$queryRaw as jest.Mock).mock.calls[0]);
    expect(
      fragments.some((fragment) => fragment.strings.join('').includes("metadata->>'role'")),
    ).toBe(false);
    expect(
      fragments.some((fragment) => fragment.strings.join('').includes("metadata->>'scenario'")),
    ).toBe(false);
  });

  it('Embedding 服务失败时 lesson 降级为空，但仍返回同桌 player_model', async () => {
    (embeddingService.embedText as jest.Mock).mockRejectedValue(new Error('embedding timeout'));
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'model-1',
        type: 'player_model',
        title: '对手建模',
        content: '谨慎型玩家',
        importance: 0.7,
      },
    ]);

    await expect(
      service.retrieveExperience({
        agentId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
        label: 'default',
        opponentAgentIds: ['333cb4ed-76dc-4392-ad6c-ed177638f7d0'],
        query: '当前应该怎么投票',
        role: 'villager',
        scenario: 'vote',
      }),
    ).resolves.toEqual({
      lessons: [],
      playerModels: [
        {
          id: 'model-1',
          type: 'player_model',
          title: '对手建模',
          content: '谨慎型玩家',
          importance: 0.7,
        },
      ],
    });
  });

  it('历史并发留下同一对手多条 active 建模时只注入最新一条', async () => {
    (embeddingService.embedText as jest.Mock).mockRejectedValue(new Error('embedding timeout'));
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'model-new',
        type: 'player_model',
        title: '新建模',
        content: '最新观察',
        importance: 0.8,
        metadata: { targetAgentId: 'opponent-1' },
      },
      {
        id: 'model-old',
        type: 'player_model',
        title: '旧建模',
        content: '旧观察',
        importance: 0.7,
        metadata: { targetAgentId: 'opponent-1' },
      },
    ]);

    const result = await service.retrieveExperience({
      agentId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
      label: 'default',
      opponentAgentIds: ['opponent-1'],
      query: '当前应该怎么投票',
      role: 'villager',
      scenario: 'vote',
    });

    expect(result.playerModels).toHaveLength(1);
    expect(result.playerModels[0].id).toBe('model-new');
  });

  it('有效候选不足 topK 时不以非正相似度 lesson 补位', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'lesson-positive',
          type: 'lesson',
          title: '相关经验',
          content: '当前局面适用',
          importance: 0.8,
          similarity: 0.7,
        },
        {
          id: 'lesson-zero',
          type: 'lesson',
          title: '无关经验',
          content: '当前局面不适用',
          importance: 1,
          similarity: 0,
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.decisionJudgment.groupBy as jest.Mock).mockResolvedValue([]);

    const result = await service.retrieveExperience({
      agentId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
      label: 'default',
      opponentAgentIds: [],
      query: '当前应该怎么投票',
      role: 'villager',
      scenario: 'vote',
      lessonLimit: 3,
    });

    expect(result.lessons.map((lesson) => lesson.id)).toEqual(['lesson-positive']);
  });

  it('按 eventId 幂等记录记忆使用关系', async () => {
    (prisma.memoryUsage.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    const rows = [
      {
        memoryId: '3d87b58d-91a4-4eb7-8d12-b191dc38691e',
        gameId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
        playerId: '333cb4ed-76dc-4392-ad6c-ed177638f7d0',
        eventId: '4e481736-282b-4e02-b343-f9cba13f89eb',
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
        triggerMatched: true,
      },
    ];

    await service.recordUsages(rows);

    expect(prisma.memoryUsage.createMany).toHaveBeenCalledWith({
      data: rows,
      skipDuplicates: true,
    });
  });
});
