import { JudgeService } from './judge.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';

/** mock PrismaService（仅覆盖 reward 回填与个人分聚合用到的读写面） */
function createMockPrisma() {
  return {
    decisionJudgment: { findMany: jest.fn(), groupBy: jest.fn() },
    memoryUsage: { findMany: jest.fn(), update: jest.fn() },
    knowledgeUsage: { findMany: jest.fn(), update: jest.fn() },
    agentPerformance: { findMany: jest.fn(), update: jest.fn() },
    gameSummary: { update: jest.fn() },
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

describe('JudgeService.aggregatePlayerScores', () => {
  let service: JudgeService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new JudgeService(
      prisma as unknown as PrismaService,
      {} as unknown as PromptService,
      {} as unknown as StructuredLlmService,
    );
  });

  it('决策与发言各占 50% 加权合成，最高分当选 MVP', async () => {
    (prisma.decisionJudgment.groupBy as jest.Mock)
      .mockResolvedValueOnce([
        { playerId: 'p1', _avg: { score: 80 } },
        { playerId: 'p2', _avg: { score: 50 } },
      ])
      .mockResolvedValueOnce([
        { playerId: 'p1', _avg: { score: 60 } },
        { playerId: 'p2', _avg: { score: 50 } },
      ]);
    (prisma.agentPerformance.findMany as jest.Mock).mockResolvedValue([
      { playerId: 'p1', isWinner: false, survivalDays: 2, voteAccuracy: 0.5 },
      { playerId: 'p2', isWinner: true, survivalDays: 4, voteAccuracy: 1 },
    ]);

    await service.aggregatePlayerScores('g1');

    // p1 = 0.5*80 + 0.5*60 = 70；p2 = 0.5*50 + 0.5*50 = 50
    expect(prisma.agentPerformance.update).toHaveBeenCalledWith({
      where: { gameId_playerId: { gameId: 'g1', playerId: 'p1' } },
      data: { score: 70 },
    });
    expect(prisma.agentPerformance.update).toHaveBeenCalledWith({
      where: { gameId_playerId: { gameId: 'g1', playerId: 'p2' } },
      data: { score: 50 },
    });
    expect(prisma.gameSummary.update).toHaveBeenCalledWith({
      where: { gameId: 'g1' },
      data: { mvpPlayerId: 'p1' },
    });
  });

  it('单维度玩家用该维度均分，不因另一维度缺失置 null', async () => {
    (prisma.decisionJudgment.groupBy as jest.Mock)
      .mockResolvedValueOnce([{ playerId: 'p1', _avg: { score: 80 } }])
      .mockResolvedValueOnce([]);
    (prisma.agentPerformance.findMany as jest.Mock).mockResolvedValue([
      { playerId: 'p1', isWinner: true, survivalDays: 3, voteAccuracy: 0.8 },
    ]);

    await service.aggregatePlayerScores('g1');

    expect(prisma.agentPerformance.update).toHaveBeenCalledWith({
      where: { gameId_playerId: { gameId: 'g1', playerId: 'p1' } },
      data: { score: 80 },
    });
    expect(prisma.gameSummary.update).toHaveBeenCalledWith({
      where: { gameId: 'g1' },
      data: { mvpPlayerId: 'p1' },
    });
  });

  it('无可评行为的玩家 score 置 null，不参与 MVP', async () => {
    (prisma.decisionJudgment.groupBy as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (prisma.agentPerformance.findMany as jest.Mock).mockResolvedValue([
      { playerId: 'p1', isWinner: false, survivalDays: 1, voteAccuracy: null },
    ]);

    await service.aggregatePlayerScores('g1');

    expect(prisma.agentPerformance.update).toHaveBeenCalledWith({
      where: { gameId_playerId: { gameId: 'g1', playerId: 'p1' } },
      data: { score: null },
    });
    expect(prisma.gameSummary.update).toHaveBeenCalledWith({
      where: { gameId: 'g1' },
      data: { mvpPlayerId: null },
    });
  });

  it('加权合成保留两位小数', async () => {
    (prisma.decisionJudgment.groupBy as jest.Mock)
      .mockResolvedValueOnce([{ playerId: 'p1', _avg: { score: 66.6667 } }])
      .mockResolvedValueOnce([{ playerId: 'p1', _avg: { score: 66.6667 } }]);
    (prisma.agentPerformance.findMany as jest.Mock).mockResolvedValue([
      { playerId: 'p1', isWinner: true, survivalDays: 3, voteAccuracy: 0.8 },
    ]);

    await service.aggregatePlayerScores('g1');

    // 0.5*66.6667 + 0.5*66.6667 = 66.6667 → 66.67
    expect(prisma.agentPerformance.update).toHaveBeenCalledWith({
      where: { gameId_playerId: { gameId: 'g1', playerId: 'p1' } },
      data: { score: 66.67 },
    });
    expect(prisma.gameSummary.update).toHaveBeenCalledWith({
      where: { gameId: 'g1' },
      data: { mvpPlayerId: 'p1' },
    });
  });
});
