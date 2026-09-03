import { JudgeService } from './judge.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';

/** mock PrismaService（仅覆盖 reward 回填用到的读写面） */
function createMockPrisma() {
  return {
    decisionJudgment: { findMany: jest.fn() },
    memoryUsage: { findMany: jest.fn(), update: jest.fn() },
    knowledgeUsage: { findMany: jest.fn(), update: jest.fn() },
    event: { findMany: jest.fn() },
  };
}

describe('JudgeService.backfillRewards', () => {
  let service: JudgeService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    // backfillRewards 现同时处理 knowledge_usages；默认无攻略注入，需覆盖时单测里 mockResolvedValue
    (prisma.knowledgeUsage.findMany as jest.Mock).mockResolvedValue([]);
    service = new JudgeService(
      prisma as unknown as PrismaService,
      {} as unknown as PromptService,
      {} as unknown as StructuredLlmService,
    );
  });

  it('通过 eventId 精确回填同一天的多条发言', async () => {
    (prisma.decisionJudgment.findMany as jest.Mock).mockResolvedValue([
      { eventId: 'e1', playerId: 'p1', actionType: 'speech', day: 1, score: 80 },
      { eventId: 'e2', playerId: 'p1', actionType: 'speech', day: 1, score: 60 },
    ]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'u1',
        eventId: 'e1',
        playerId: 'p1',
        actionType: 'speech',
        day: 1,
        rewardScore: null,
      },
      {
        id: 'u2',
        eventId: 'e2',
        playerId: 'p1',
        actionType: 'speech',
        day: 1,
        rewardScore: null,
      },
    ]);

    const n = await service.backfillRewards('g1');

    expect(n).toBe(2);
    expect(prisma.memoryUsage.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'u1' },
      data: { rewardScore: 80 },
    });
    expect(prisma.memoryUsage.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'u2' },
      data: { rewardScore: 60 },
    });
  });

  it('重评后刷新 eventId 已有的旧 rewardScore', async () => {
    (prisma.decisionJudgment.findMany as jest.Mock).mockResolvedValue([
      { eventId: 'e1', playerId: 'p1', actionType: 'vote', day: 1, score: 85 },
    ]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'u1',
        eventId: 'e1',
        playerId: 'p1',
        actionType: 'vote',
        day: 1,
        rewardScore: 40,
      },
    ]);

    const n = await service.backfillRewards('g1');

    expect(n).toBe(1);
    expect(prisma.memoryUsage.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { rewardScore: 85 },
    });
  });

  it('旧 usage 无 eventId 时，同键唯一仍可兼容回填', async () => {
    (prisma.decisionJudgment.findMany as jest.Mock).mockResolvedValue([
      { eventId: 'e1', playerId: 'p1', actionType: 'vote', day: 1, score: 80 },
    ]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'u1',
        eventId: null,
        playerId: 'p1',
        actionType: 'vote',
        day: 1,
        rewardScore: null,
      },
    ]);
    (prisma.event.findMany as jest.Mock).mockResolvedValue([
      { id: 'e1', actorId: 'p1', actionType: 'vote', day: 1 },
    ]);

    const n = await service.backfillRewards('g1');

    expect(n).toBe(1);
    expect(prisma.memoryUsage.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { rewardScore: 80 },
    });
  });

  it('旧 usage 的粗键变得有歧义时清除陈旧 reward', async () => {
    (prisma.decisionJudgment.findMany as jest.Mock).mockResolvedValue([
      { eventId: 'e1', playerId: 'p1', actionType: 'speech', day: 1, score: 80 },
      { eventId: 'e2', playerId: 'p1', actionType: 'speech', day: 1, score: 60 },
    ]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'u1',
        eventId: null,
        playerId: 'p1',
        actionType: 'speech',
        day: 1,
        rewardScore: 70,
      },
    ]);
    (prisma.event.findMany as jest.Mock).mockResolvedValue([
      { id: 'e1', actorId: 'p1', actionType: 'speech', day: 1 },
      { id: 'e2', actorId: 'p1', actionType: 'speech', day: 1 },
    ]);

    const n = await service.backfillRewards('g1');

    expect(n).toBe(0);
    expect(prisma.memoryUsage.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { rewardScore: null },
    });
  });

  it('旧 usage 即使只有一条评分，底层同键有多次行为时也不粗关联', async () => {
    (prisma.decisionJudgment.findMany as jest.Mock).mockResolvedValue([
      { eventId: 'pk-vote', playerId: 'p1', actionType: 'vote', day: 1, score: 90 },
    ]);
    (prisma.memoryUsage.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'u1',
        eventId: null,
        playerId: 'p1',
        actionType: 'vote',
        day: 1,
        rewardScore: 75,
      },
    ]);
    (prisma.event.findMany as jest.Mock).mockResolvedValue([
      { id: 'regular-abstain', actorId: 'p1', actionType: 'vote', day: 1 },
      { id: 'pk-vote', actorId: 'p1', actionType: 'vote', day: 1 },
    ]);

    await expect(service.backfillRewards('g1')).resolves.toBe(0);
    expect(prisma.memoryUsage.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { rewardScore: null },
    });
  });
});
