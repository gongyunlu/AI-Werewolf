import type { Prisma } from '../generated/prisma/client';
import { ACTION_TYPES } from '@ai-werewolf/shared';

/** 只维护经验检索所需奖励；在整批评分采用事务中同步刷新，知识使用不维护分数副本。 */
export async function backfillMemoryRewards(
  prisma: Prisma.TransactionClient,
  gameId: string,
): Promise<number> {
  const [judgments, usages] = await Promise.all([
    prisma.decisionJudgment.findMany({
      where: { gameId },
      select: { eventId: true, playerId: true, actionType: true, day: true, score: true },
    }),
    prisma.memoryUsage.findMany({
      where: { gameId },
      select: {
        id: true,
        eventId: true,
        playerId: true,
        actionType: true,
        day: true,
        rewardScore: true,
      },
    }),
  ]);

  const scoreByEventId = new Map(judgments.map((j) => [j.eventId, j.score]));
  const teamScores = await prisma.teamJudgment.findMany({
    where: { gameId },
    select: { eventId: true, score: true },
  });
  if (teamScores.length) {
    const kills = await prisma.event.findMany({
      where: {
        gameId,
        id: { in: teamScores.map((j) => j.eventId) },
        actionType: ACTION_TYPES.WOLF_KILL,
      },
      select: { id: true, content: true },
    });
    for (const kill of kills) {
      const proposalIds = (kill.content as Record<string, unknown>).proposalEventIds;
      if (Array.isArray(proposalIds))
        for (const id of proposalIds)
          if (typeof id === 'string')
            scoreByEventId.set(id, teamScores.find((j) => j.eventId === kill.id)!.score);
    }
  }
  // 仅供迁移前的旧 usage 使用。必须检查底层真实 Event 是否也唯一，不能只数评分。
  const legacyScoreByKey = new Map<string, number>();
  if (usages.some((usage) => usage.eventId === null)) {
    const events = await prisma.event.findMany({
      where: { gameId, actorId: { not: null }, day: { not: null } },
      select: { id: true, actorId: true, actionType: true, day: true },
    });
    const eventIdsByKey = new Map<string, string[]>();
    for (const event of events) {
      if (!event.actorId || event.day === null) continue;
      const key = `${event.actorId}|${event.actionType}|${event.day}`;
      const list = eventIdsByKey.get(key);
      if (list) list.push(event.id);
      else eventIdsByKey.set(key, [event.id]);
    }
    for (const [key, eventIds] of eventIdsByKey) {
      if (eventIds.length !== 1) continue;
      const score = scoreByEventId.get(eventIds[0]);
      if (score !== undefined) legacyScoreByKey.set(key, score);
    }
  }

  let filled = 0;
  for (const u of usages) {
    const nextScore = u.eventId
      ? (scoreByEventId.get(u.eventId) ?? null)
      : (legacyScoreByKey.get(`${u.playerId}|${u.actionType}|${u.day}`) ?? null);

    if (u.rewardScore === nextScore) {
      if (nextScore !== null) filled += 1;
      continue;
    }

    await prisma.memoryUsage.update({
      where: { id: u.id },
      data: { rewardScore: nextScore },
    });
    if (nextScore !== null) filled += 1;
  }

  return filled;
}
