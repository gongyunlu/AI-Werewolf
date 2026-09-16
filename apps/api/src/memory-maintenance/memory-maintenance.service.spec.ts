import type { Queue } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmbeddingService } from '../memory/embedding.service';
import { MEMORY_EMBEDDING_DIMENSION } from '../memory/embedding.service';
import type { MemoryService } from '../memory/memory.service';
import type { PromptService } from '../observability/prompt.service';
import type { ModelGenerationService } from '../llm/model-generation.service';
import { MemoryMaintenanceService, maintenancePlan } from './memory-maintenance.service';

function createMockPrisma() {
  return {
    player: { findMany: jest.fn() },
    memory: { updateMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    memoryDerivation: { createMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
}

function createMockEmbeddingService() {
  return {
    model: 'test-embedding-model',
    dimension: MEMORY_EMBEDDING_DIMENSION,
  };
}

describe('maintenancePlan', () => {
  it.each([
    [0, { decay: false, archive: false, dedup: false, consolidate: false }],
    [9, { decay: false, archive: false, dedup: false, consolidate: false }],
    [10, { decay: false, archive: false, dedup: false, consolidate: false }],
    [49, { decay: false, archive: false, dedup: false, consolidate: false }],
    [50, { decay: true, archive: true, dedup: false, consolidate: false }],
    [60, { decay: true, archive: false, dedup: false, consolidate: false }],
    [99, { decay: false, archive: false, dedup: false, consolidate: false }],
    [100, { decay: true, archive: true, dedup: true, consolidate: true }],
    [150, { decay: true, archive: true, dedup: false, consolidate: false }],
    [200, { decay: true, archive: true, dedup: true, consolidate: true }],
  ])('gameCount=%d 触发 %j', (gameCount, expected) => {
    expect(maintenancePlan(gameCount)).toEqual(expected);
  });
});

describe('MemoryMaintenanceService', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: MemoryMaintenanceService;
  let queue: { getJob: jest.Mock; add: jest.Mock };

  const emptyResult = { agents: 1, decayed: 0, archived: 0, deduped: 0, consolidated: 0 };

  beforeEach(() => {
    prisma = createMockPrisma();
    queue = { getJob: jest.fn(), add: jest.fn() };
    service = new MemoryMaintenanceService(
      queue as unknown as Queue,
      prisma as unknown as PrismaService,
      createMockEmbeddingService() as unknown as EmbeddingService,
      { embedMemories: jest.fn() } as unknown as MemoryService,
      { render: jest.fn() } as unknown as PromptService,
      { invoke: jest.fn() } as unknown as ModelGenerationService,
    );
    prisma.player.findMany.mockResolvedValue([
      { id: 'p1', agentId: 'a1', memoryLabelSnapshot: 'label1' },
    ]);
  });

  it('未到边界时只计数，不执行任何维护', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 7 }]);
    const result = await service.runForGame('g1');
    expect(result).toEqual(emptyResult);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('第 50 局触发衰减 + 归档，归档在容量内则不驱逐', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 50 }]) // countGames
      .mockResolvedValueOnce([{ total: 10 }]); // archive 容量内
    prisma.$executeRaw.mockResolvedValue(1);

    const result = await service.runForGame('g1');
    expect(result).toEqual({ ...emptyResult, decayed: 1 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('超出容量时驱逐最冷的 lesson/reflection', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ count: 50 }]) // countGames
      .mockResolvedValueOnce([{ total: 520 }]) // 超出容量
      .mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]); // 最冷 20 条里的示例
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.memory.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.runForGame('g1');
    expect(result).toEqual({ ...emptyResult, decayed: 1, archived: 2 });
    expect(prisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] }, isActive: true },
      data: { isActive: false },
    });
  });

  it('任务已存在时跳过重复投递', async () => {
    queue.getJob.mockResolvedValue({
      id: 'job-1',
      getState: jest.fn().mockResolvedValue('completed'),
    });
    await service.enqueueForGame('g1');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('任务不存在时按稳定 jobId 投递', async () => {
    queue.getJob.mockResolvedValue(null);
    await service.enqueueForGame('g1');
    expect(queue.add).toHaveBeenCalledWith(
      'run',
      { gameId: 'g1' },
      expect.objectContaining({ jobId: 'maintenance_g1' }),
    );
  });

  it('恢复耗尽重试的失败任务，保留同一个 jobId', async () => {
    const job = { getState: jest.fn().mockResolvedValue('failed'), retry: jest.fn() };
    queue.getJob.mockResolvedValue(job);
    await service.enqueueForGame('g1');
    expect(job.retry).toHaveBeenCalledWith('failed');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
