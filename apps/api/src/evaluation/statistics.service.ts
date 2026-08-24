import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FACTIONS } from '@ai-werewolf/shared';

/** 三阵营胜率 */
function emptyWinRates(): Record<string, number> {
  return {
    [FACTIONS.VILLAGER]: 0,
    [FACTIONS.WEREWOLF]: 0,
    [FACTIONS.THIRD_PARTY]: 0,
  };
}

/**
 * 统计服务：提供胜率、排行、决策质量等查询
 */
@Injectable()
export class StatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 总对局数 / 平均天数 / 三阵营胜率 */
  async summary() {
    const [totalGames, agg, byFaction] = await Promise.all([
      this.prisma.gameSummary.count(),
      this.prisma.gameSummary.aggregate({ _avg: { totalDays: true } }),
      this.prisma.gameSummary.groupBy({ by: ['winnerFaction'], _count: true }),
    ]);

    const winRates = emptyWinRates();
    for (const row of byFaction) {
      winRates[row.winnerFaction] =
        totalGames > 0 ? Number((row._count / totalGames).toFixed(4)) : 0;
    }

    return {
      totalGames,
      avgDays: Number((agg._avg.totalDays ?? 0).toFixed(2)),
      winRates,
    };
  }

  /** 按 winnerFaction 聚合的胜负分布 */
  async factions() {
    const byFaction = await this.prisma.gameSummary.groupBy({
      by: ['winnerFaction'],
      _count: true,
    });
    return byFaction.map((row) => ({ winnerFaction: row.winnerFaction, games: row._count }));
  }

  /** Agent 排行：按 agentId 内存聚合（作品集规模足够，避免 raw SQL） */
  async agentsRanking(minGames = 1, role?: string) {
    const performances = await this.prisma.agentPerformance.findMany({
      where: role ? { role } : undefined,
      include: {
        player: { select: { agentId: true, displayName: true, modelName: true } },
      },
    });

    interface Acc {
      agentId: string;
      name: string;
      modelName: string;
      games: number;
      wins: number;
      scoreSum: number;
      scoreCount: number;
      survivalSum: number;
      voteAccSum: number;
      voteAccCount: number;
    }

    const map = new Map<string, Acc>();
    for (const p of performances) {
      const key = p.player.agentId;
      let acc = map.get(key);
      if (!acc) {
        acc = {
          agentId: key,
          name: p.player.displayName,
          modelName: p.player.modelName,
          games: 0,
          wins: 0,
          scoreSum: 0,
          scoreCount: 0,
          survivalSum: 0,
          voteAccSum: 0,
          voteAccCount: 0,
        };
        map.set(key, acc);
      }
      acc.games += 1;
      if (p.isWinner) acc.wins += 1;
      if (p.score !== null) {
        acc.scoreSum += p.score;
        acc.scoreCount += 1;
      }
      acc.survivalSum += p.survivalDays;
      if (p.voteAccuracy !== null) {
        acc.voteAccSum += p.voteAccuracy;
        acc.voteAccCount += 1;
      }
    }

    return [...map.values()]
      .filter((acc) => acc.games >= minGames)
      .map((acc) => ({
        agentId: acc.agentId,
        name: acc.name,
        modelName: acc.modelName,
        games: acc.games,
        wins: acc.wins,
        winRate: Number((acc.wins / acc.games).toFixed(4)),
        avgScore: acc.scoreCount > 0 ? Number((acc.scoreSum / acc.scoreCount).toFixed(2)) : null,
        avgSurvivalDays: Number((acc.survivalSum / acc.games).toFixed(2)),
        avgVoteAccuracy:
          acc.voteAccCount > 0 ? Number((acc.voteAccSum / acc.voteAccCount).toFixed(4)) : null,
      }))
      .toSorted((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
  }

  /** 决策质量：整体 + 按动作类型的平均分 */
  async decisionQuality() {
    const [overall, byAction] = await Promise.all([
      this.prisma.decisionJudgment.aggregate({ _avg: { score: true }, _count: true }),
      this.prisma.decisionJudgment.groupBy({
        by: ['actionType'],
        _avg: { score: true },
        _count: true,
      }),
    ]);

    return {
      overall: {
        avgScore: overall._avg.score ?? null,
        count: overall._count,
      },
      byAction: byAction.map((r) => ({
        actionType: r.actionType,
        avgScore: r._avg.score ?? null,
        count: r._count,
      })),
    };
  }

  /** 单局评估详情：摘要 + 各玩家表现 */
  async gameDetail(gameId: string) {
    const [summary, performances] = await Promise.all([
      this.prisma.gameSummary.findUnique({ where: { gameId } }),
      this.prisma.agentPerformance.findMany({
        where: { gameId },
        include: { player: { select: { seatNo: true, displayName: true } } },
        orderBy: { score: 'desc' },
      }),
    ]);

    return { summary, performances };
  }
}
