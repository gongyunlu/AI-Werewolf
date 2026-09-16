import type { PrismaService } from '../prisma/prisma.service';
import { backfillMemoryRewards } from './memory-reward';
import { aggregatePlayerScores } from './player-score';

/** mock PrismaService（仅覆盖 reward 回填与个人分聚合用到的读写面） */
function createMockPrisma() {
  const db = {
    teamJudgment: { findMany: jest.fn().mockResolvedValue([]) },
    decisionJudgment: { findMany: jest.fn(), groupBy: jest.fn() },
    memoryUsage: { findMany: jest.fn(), update: jest.fn() },
    knowledgeUsage: { findMany: jest.fn(), update: jest.fn() },
    agentPerformance: { findMany: jest.fn(), update: jest.fn() },
    gameSummary: { update: jest.fn() },
    event: { findMany: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (task) => task(db));
  return db;
}

describe('backfillMemoryRewards', () => {
  it('只回填有排序消费者的记忆，不再读取或维护攻略分数副本', async () => {
    const db = createMockPrisma();
    db.decisionJudgment.findMany.mockResolvedValue([]);
    db.memoryUsage.findMany.mockResolvedValue([]);
    db.knowledgeUsage.findMany.mockResolvedValue([]);
    await backfillMemoryRewards(db as unknown as PrismaService, 'g');
    expect(db.knowledgeUsage.findMany).not.toHaveBeenCalled();
    expect(db.knowledgeUsage.update).not.toHaveBeenCalled();
  });
  it('团队狼刀分数通过提刀事件关联回填记忆 usage', async () => {
    const db = createMockPrisma();
    db.decisionJudgment.findMany.mockResolvedValue([]);
    db.teamJudgment.findMany.mockResolvedValue([{ eventId: 'kill', score: 88 }]);
    db.event.findMany.mockResolvedValue([
      { id: 'kill', content: { proposalEventIds: ['proposal'] } },
    ]);
    const usage = {
      id: 'u',
      eventId: 'proposal',
      playerId: 'p',
      actionType: 'wolf_proposal',
      day: 1,
      rewardScore: null,
    };
    db.memoryUsage.findMany.mockResolvedValue([usage]);
    db.knowledgeUsage.findMany.mockResolvedValue([usage]);
    await backfillMemoryRewards(db as unknown as PrismaService, 'g');
    for (const table of [db.memoryUsage])
      expect(table.update).toHaveBeenCalledWith({ where: { id: 'u' }, data: { rewardScore: 88 } });
  });
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    // 攻略使用关系保留历史读取桩，本路径不再读取分数副本。
    (prisma.knowledgeUsage.findMany as jest.Mock).mockResolvedValue([]);
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

    const n = await backfillMemoryRewards(prisma as unknown as PrismaService, 'g1');

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

    const n = await backfillMemoryRewards(prisma as unknown as PrismaService, 'g1');

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

    const n = await backfillMemoryRewards(prisma as unknown as PrismaService, 'g1');

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

    const n = await backfillMemoryRewards(prisma as unknown as PrismaService, 'g1');

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

    await expect(backfillMemoryRewards(prisma as unknown as PrismaService, 'g1')).resolves.toBe(0);
    expect(prisma.memoryUsage.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { rewardScore: null },
    });
  });
});

describe('aggregatePlayerScores', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
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

    await aggregatePlayerScores(prisma as unknown as PrismaService, 'g1');

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

    await aggregatePlayerScores(prisma as unknown as PrismaService, 'g1');

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

    await aggregatePlayerScores(prisma as unknown as PrismaService, 'g1');

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

    await aggregatePlayerScores(prisma as unknown as PrismaService, 'g1');

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
