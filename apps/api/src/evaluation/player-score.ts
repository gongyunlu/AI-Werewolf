import type { PrismaClient } from '../generated/prisma/client';
import { ACTION_TYPES } from '@ai-werewolf/shared';
import { selectMvp, type MvpCandidate } from './metrics';

/** 决策均分与发言均分各占 50%；缺失一方时用另一方（单维度玩家不置 null）。 */
function combinePlayerScore(
  decisionAvg: number | null | undefined,
  speechAvg: number | null | undefined,
): number | null {
  const d = decisionAvg ?? null;
  const s = speechAvg ?? null;
  if (d === null) {
    return s === null ? null : Math.round(s * 100) / 100;
  }
  if (s === null) {
    return Math.round(d * 100) / 100;
  }
  return Math.round((0.5 * d + 0.5 * s) * 100) / 100;
}

/**
 * 聚合一局每个玩家的 judge 过程分：决策均分与发言均分各占 50% 加权合成，写入 AgentPerformance.score，
 * 并按该分选出 MVP 写入 GameSummary.mvpPlayerId。
 *
 * 个人分语义：过程质量（收益最大化程度），由 judge 在决策时点视角给出。MVP 排序以过程分
 * 为主，仅并列时用胜负/存活/投票精度依次破平局。无任何评分数据的玩家 score 置 NULL
 * （区别于「打得差分数低」，NULL 表示「无可评行为」），也不参与 MVP。
 *
 * 纯函数（仅依赖 prisma），供 JudgeService 与批量迁移脚本复用，不依赖 Nest DI。
 */
export async function aggregatePlayerScores(
  prisma: PrismaClient,
  gameId: string,
): Promise<{ scored: number; total: number }> {
  const [decisionGrouped, speechGrouped, performances] = await Promise.all([
    prisma.decisionJudgment.groupBy({
      by: ['playerId'],
      where: { gameId, actionType: { not: ACTION_TYPES.SPEECH } },
      _avg: { score: true },
    }),
    prisma.decisionJudgment.groupBy({
      by: ['playerId'],
      where: { gameId, actionType: ACTION_TYPES.SPEECH },
      _avg: { score: true },
    }),
    prisma.agentPerformance.findMany({
      where: { gameId },
      select: { playerId: true, isWinner: true, survivalDays: true, voteAccuracy: true },
    }),
  ]);

  const decisionAvgByPlayer = new Map(decisionGrouped.map((g) => [g.playerId, g._avg.score]));
  const speechAvgByPlayer = new Map(speechGrouped.map((g) => [g.playerId, g._avg.score]));

  const candidates: MvpCandidate[] = [];
  for (const p of performances) {
    const score = combinePlayerScore(
      decisionAvgByPlayer.get(p.playerId),
      speechAvgByPlayer.get(p.playerId),
    );
    await prisma.agentPerformance.update({
      where: { gameId_playerId: { gameId, playerId: p.playerId } },
      data: { score },
    });
    if (score === null) continue;
    candidates.push({
      playerId: p.playerId,
      score,
      isWinner: p.isWinner,
      survivalDays: p.survivalDays,
      voteAccuracy: p.voteAccuracy,
    });
  }

  await prisma.gameSummary.update({
    where: { gameId },
    data: { mvpPlayerId: selectMvp(candidates) },
  });

  return { scored: candidates.length, total: performances.length };
}
