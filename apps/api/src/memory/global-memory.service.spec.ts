import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingService } from './embedding.service';
import { GlobalMemoryService } from './global-memory.service';

function createMockPrisma() {
  const prisma = {
    patternCandidate: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    globalMemory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(prisma));
  return prisma as unknown as PrismaService;
}

function createMockEmbeddingService() {
  return {
    model: 'test-embedding-model',
    dimension: 2048,
    embedTexts: jest.fn(),
  } as unknown as EmbeddingService;
}

const pattern = {
  title: '预言家首日应起跳',
  content: '首夜验出金水且场上无人对跳时起跳',
  importance: 0.8,
};
const vector = [0.1, 0.2, 0.3];

describe('GlobalMemoryService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;
  let service: GlobalMemoryService;

  beforeEach(() => {
    prisma = createMockPrisma();
    embeddingService = createMockEmbeddingService();
    service = new GlobalMemoryService(prisma, embeddingService);
  });

  it('同一对局重复调用不重复累加（幂等）', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ count: 1 }]);

    await expect(service.promotePatterns('g1', [pattern])).resolves.toBe(0);
    expect(embeddingService.embedTexts).not.toHaveBeenCalled();
  });

  it('同一认知在第 3 场对局出现时晋升为全局记忆', async () => {
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ count: 0 }]) // 幂等检查
      .mockResolvedValueOnce([{ count: 0 }]) // 锁内重新检查
      .mockResolvedValueOnce([{ id: 'cand-1', similarity: 0.9 }]) // 相似候选
      .mockResolvedValueOnce([
        {
          id: 'cand-1',
          title: pattern.title,
          content: pattern.content,
          importance: pattern.importance,
          source_game_ids: ['g1', 'g2', 'g3'],
        },
      ]); // ready 候选
    (embeddingService.embedTexts as jest.Mock).mockResolvedValue([vector]);
    (prisma.patternCandidate.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      sourceGameIds: ['g1', 'g2'],
    });
    (prisma.patternCandidate.update as jest.Mock).mockResolvedValue({});
    (prisma.globalMemory.create as jest.Mock).mockResolvedValue({});

    await expect(service.promotePatterns('g3', [pattern])).resolves.toBe(1);

    // 归簇：来源对局去重后写回
    expect(prisma.patternCandidate.update).toHaveBeenCalledWith({
      where: { id: 'cand-1' },
      data: { sourceGameIds: ['g1', 'g2', 'g3'] },
    });
    // 晋升：写 global_memories
    expect(prisma.globalMemory.create).toHaveBeenCalledWith({
      data: {
        type: 'pattern',
        source: 'aggregated',
        title: pattern.title,
        content: pattern.content,
        importance: pattern.importance,
        sourceGameIds: ['g1', 'g2', 'g3'],
        isActive: true,
      },
    });
    // 标记晋升
    expect(prisma.patternCandidate.update).toHaveBeenCalledWith({
      where: { id: 'cand-1' },
      data: { promotedAt: expect.any(Date) },
    });
  });

  it('相似度恰好0.85可归簇，同一认知只出现2场时不晋升', async () => {
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ count: 0 }]) // 幂等检查
      .mockResolvedValueOnce([{ count: 0 }]) // 锁内重新检查
      .mockResolvedValueOnce([{ id: 'cand-1', similarity: 0.85 }]) // 相似候选
      .mockResolvedValueOnce([]); // 无 ready 候选
    (embeddingService.embedTexts as jest.Mock).mockResolvedValue([vector]);
    (prisma.patternCandidate.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      sourceGameIds: ['g1'],
    });
    (prisma.patternCandidate.update as jest.Mock).mockResolvedValue({});

    await expect(service.promotePatterns('g2', [pattern])).resolves.toBe(0);

    expect(prisma.globalMemory.create).not.toHaveBeenCalled();
    // 只有归簇这一次 update，无 promotedAt 标记
    expect(prisma.patternCandidate.update).toHaveBeenCalledTimes(1);
    expect(prisma.patternCandidate.update).toHaveBeenCalledWith({
      where: { id: 'cand-1' },
      data: { sourceGameIds: ['g1', 'g2'] },
    });
  });

  it('相似度低于阈值时新建候选并写入 embedding', async () => {
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ count: 0 }]) // 幂等检查
      .mockResolvedValueOnce([{ count: 0 }]) // 锁内重新检查
      .mockResolvedValueOnce([]) // 无相似候选
      .mockResolvedValueOnce([]); // 无 ready 候选
    (embeddingService.embedTexts as jest.Mock).mockResolvedValue([vector]);
    (prisma.patternCandidate.create as jest.Mock).mockResolvedValue({ id: 'new-cand' });
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    await expect(service.promotePatterns('g1', [pattern])).resolves.toBe(0);

    expect(prisma.patternCandidate.create).toHaveBeenCalledWith({
      data: {
        gameId: 'g1',
        title: pattern.title,
        content: pattern.content,
        importance: pattern.importance,
        sourceGameIds: ['g1'],
      },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('检索已晋升的全局 pattern', async () => {
    (prisma.globalMemory.findMany as jest.Mock).mockResolvedValue([
      { title: pattern.title, content: pattern.content },
    ]);

    await expect(service.retrieveActivePatterns()).resolves.toEqual([
      { title: pattern.title, content: pattern.content },
    ]);
    expect(prisma.globalMemory.findMany).toHaveBeenCalledWith({
      where: { type: 'pattern', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { title: true, content: true },
    });
  });
});
