import { SettlementService } from './settlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';

/** 构造 mock PrismaService（仅覆盖结算服务用到的读写面） */
function createMockPrisma() {
  return {
    game: { findUnique: jest.fn() },
    player: { findMany: jest.fn() },
    event: { findMany: jest.fn() },
    agentPerformance: { upsert: jest.fn() },
    gameSummary: { upsert: jest.fn() },
  } as unknown as PrismaService;
}

const FINISHED_GAME = { status: GAME_STATUSES.FINISHED, winnerFaction: 'villager', totalDays: 3 };

const PLAYERS = [
  { id: 'p1', seatNo: 1, role: 'seer', faction: 'villager', deathDay: null, deathCause: null },
  {
    id: 'p2',
    seatNo: 2,
    role: 'werewolf',
    faction: 'werewolf',
    deathDay: 2,
    deathCause: 'execution',
  },
];

describe('SettlementService', () => {
  let service: SettlementService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new SettlementService(prisma);
    (prisma.game.findUnique as jest.Mock).mockResolvedValue(FINISHED_GAME);
    (prisma.player.findMany as jest.Mock).mockResolvedValue(PLAYERS);
    (prisma.event.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('为每个玩家写入一条 AgentPerformance，并写入一条 GameSummary', async () => {
    await service.settleGame('g1');

    expect(prisma.agentPerformance.upsert).toHaveBeenCalledTimes(PLAYERS.length);
    expect(prisma.gameSummary.upsert).toHaveBeenCalledTimes(1);
  });

  it('AgentPerformance 用 gameId_playerId 唯一键 upsert（幂等）', async () => {
    await service.settleGame('g1');

    const firstCall = (prisma.agentPerformance.upsert as jest.Mock).mock.calls[0][0];
    expect(firstCall.where).toEqual({ gameId_playerId: { gameId: 'g1', playerId: 'p1' } });
  });

  it('GameSummary 用 gameId 唯一键 upsert（幂等）', async () => {
    await service.settleGame('g1');

    const call = (prisma.gameSummary.upsert as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ gameId: 'g1' });
    expect(call.create).toMatchObject({
      gameId: 'g1',
      winnerFaction: 'villager',
      totalDays: 3,
    });
  });

  it('对局未结束时跳过结算', async () => {
    (prisma.game.findUnique as jest.Mock).mockResolvedValue({
      status: GAME_STATUSES.RUNNING,
      winnerFaction: null,
      totalDays: null,
    });

    await service.settleGame('g1');

    expect(prisma.agentPerformance.upsert).not.toHaveBeenCalled();
    expect(prisma.gameSummary.upsert).not.toHaveBeenCalled();
  });

  it('缺少胜负/天数数据时抛错，不写任何记录', async () => {
    (prisma.game.findUnique as jest.Mock).mockResolvedValue({
      status: GAME_STATUSES.FINISHED,
      winnerFaction: null,
      totalDays: null,
    });

    await expect(service.settleGame('g1')).rejects.toThrow('缺少胜负/天数');
    expect(prisma.agentPerformance.upsert).not.toHaveBeenCalled();
    expect(prisma.gameSummary.upsert).not.toHaveBeenCalled();
  });
});
