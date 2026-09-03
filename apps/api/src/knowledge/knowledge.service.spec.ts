import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingService } from '../memory/embedding.service';
import { MEMORY_EMBEDDING_DIMENSION } from '../memory/embedding.service';
import { KnowledgeService } from './knowledge.service';

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    knowledgeUsage: { createMany: jest.fn() },
  } as unknown as PrismaService;
}

function createMockEmbeddingService() {
  return {
    model: 'doubao-embedding-vision',
    dimension: MEMORY_EMBEDDING_DIMENSION,
    embedText: jest.fn(),
  } as unknown as EmbeddingService;
}

type SqlFragment = { strings: string[]; values: unknown[] };

/** 从 $queryRaw tagged-template mock 调用参数里提取 Prisma.sql 片段（值为带 strings/values 的对象，Prisma.empty 也是） */
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

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '3d87b58d-91a4-4eb7-8d12-b191dc38691e',
    role: 'seer',
    scenario: 'night_action',
    trigger: '我是预言家，警上前置位有悍跳狼',
    action: '稳住心态，把验人心路历程讲完整',
    content: '当预言家遇到悍跳狼，状态、逻辑、警徽流三点',
    article_title: '当预言家遇上悍跳狼怎么办',
    section_title: '不慌不忙，表明立场',
    similarity: 0.72,
    ...overrides,
  };
}

describe('KnowledgeService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let embeddingService: ReturnType<typeof createMockEmbeddingService>;
  let service: KnowledgeService;

  beforeEach(() => {
    prisma = createMockPrisma();
    embeddingService = createMockEmbeddingService();
    service = new KnowledgeService(prisma, embeddingService);
  });

  it('按相似度下限过滤并截取前 4 条，返回蒸馏字段', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    const rows = [
      makeRow({ id: 'a', similarity: 0.55 }),
      makeRow({ id: 'b', similarity: 0.3 }), // 低于下限，剔除
      makeRow({ id: 'c', similarity: 0.9 }),
      makeRow({ id: 'd', similarity: 0.62 }),
      makeRow({ id: 'e', similarity: 0.5 }),
      makeRow({ id: 'f', similarity: 0.45 }), // 候选第 6 条，截断
    ];
    (prisma.$queryRaw as jest.Mock).mockResolvedValue(rows);

    const result = await service.retrieve('我是女巫，夜里该不该救刀口', 'witch', 'night_action');

    // 服务按 SQL 返回顺序（已降序）保序过滤 + 截取前 4，不重排
    expect(result.map((hit) => hit.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(result[0]).toMatchObject({
      role: 'seer',
      scenario: 'night_action',
      trigger: '我是预言家，警上前置位有悍跳狼',
      action: '稳住心态，把验人心路历程讲完整',
      articleTitle: '当预言家遇上悍跳狼怎么办',
      similarity: 0.55,
    });
  });

  it('传具体 role 时拼接 role = X OR role = any 硬过滤', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.retrieve('投票', 'seer', 'vote');

    const call = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    // role 走 Prisma.sql 片段（参数化值为 'seer'），scenario 直接内联进模板作为 bind 参数
    const roleFragment = sqlFragments(call).find((fragment) =>
      fragment.strings.join('').includes('(role = '),
    );
    expect(roleFragment?.strings.join('')).toContain(` OR role = 'any')`);
    expect(roleFragment?.values).toContain('seer');
    expect(call.some((value) => value === 'vote')).toBe(true);
  });

  it('role 为 null 时不拼接角色硬过滤', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

    await service.retrieve('投票', null, 'vote');

    const call = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    expect(
      sqlFragments(call).some((fragment) => fragment.strings.join('').includes('(role = ')),
    ).toBe(false);
    expect(call.some((value) => value === 'vote')).toBe(true);
  });

  it('embedding 服务失败时降级为空，不抛出', async () => {
    (embeddingService.embedText as jest.Mock).mockRejectedValue(new Error('embedding timeout'));

    await expect(
      service.retrieve('我是女巫，该不该用毒', 'witch', 'night_action'),
    ).resolves.toEqual([]);
  });

  it('SQL 查询失败时降级为空，不抛出', async () => {
    (embeddingService.embedText as jest.Mock).mockResolvedValue(
      Array<number>(MEMORY_EMBEDDING_DIMENSION).fill(0.1),
    );
    (prisma.$queryRaw as jest.Mock).mockRejectedValue(
      new Error('relation "knowledge_chunks" does not exist'),
    );

    await expect(
      service.retrieve('我是女巫，该不该用毒', 'witch', 'night_action'),
    ).resolves.toEqual([]);
  });

  it('按 eventId 幂等记录攻略注入关系', async () => {
    (prisma.knowledgeUsage.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    const rows = [
      {
        chunkId: '3d87b58d-91a4-4eb7-8d12-b191dc38691e',
        gameId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
        playerId: '333cb4ed-76dc-4392-ad6c-ed177638f7d0',
        eventId: '4e481736-282b-4e02-b343-f9cba13f89eb',
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
      },
    ];

    await service.recordUsages(rows);

    expect(prisma.knowledgeUsage.createMany).toHaveBeenCalledWith({
      data: rows,
      skipDuplicates: true,
    });
  });

  it('攻略注入记录为空时不调用创建', async () => {
    await service.recordUsages([]);
    expect(prisma.knowledgeUsage.createMany).not.toHaveBeenCalled();
  });

  it('攻略注入记录写入失败时降级，不抛出', async () => {
    (prisma.knowledgeUsage.createMany as jest.Mock).mockRejectedValue(new Error('db down'));
    const rows = [
      {
        chunkId: '3d87b58d-91a4-4eb7-8d12-b191dc38691e',
        gameId: '5b12e37c-62ca-491a-a46d-a649d08416fd',
        playerId: '333cb4ed-76dc-4392-ad6c-ed177638f7d0',
        eventId: '4e481736-282b-4e02-b343-f9cba13f89eb',
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
      },
    ];

    await expect(service.recordUsages(rows)).resolves.toBeUndefined();
  });
});
