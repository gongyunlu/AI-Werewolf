import type { Prisma } from '../generated/prisma/client';
import { evaluationCompleteness } from '../evaluation/evaluation-completeness';

/** 历史本地评分没有平台定义，沿用原产物读取契约。 */
export async function loadPlatformEvaluationRun(
  db: Pick<Prisma.TransactionClient, 'evaluationRun'>,
  gameId: string,
) {
  const run = await db.evaluationRun.findFirst({
    where: { gameId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, definition: true, expectedEventIds: true },
  });
  return run?.definition ? run : null;
}

export function reviewMatchesEvaluation(
  narrative: string | null | undefined,
  runId?: string,
): boolean {
  if (!narrative) return false;
  if (!runId) return true;
  try {
    return JSON.parse(narrative)?.evaluationRunId === runId;
  } catch {
    return false;
  }
}

/** 与整批采用共用锁；事务内读取完整业务投影，模型生成后写入时再次核对引用。 */
export async function lockReflectionEvaluation(
  tx: Prisma.TransactionClient,
  gameId: string,
  expected?: { runId: string | undefined },
): Promise<string | undefined> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
  const run = await loadPlatformEvaluationRun(tx, gameId);
  if (expected && run?.id !== expected.runId) {
    throw new Error(`对局 ${gameId} 的评分采用版本已更改，请重新生成反思`);
  }
  if (!run) return undefined;
  if (run.status !== 'complete') {
    throw new Error(`对局 ${gameId} 的评分批次尚未完整采用，无法生成复盘或反思`);
  }
  const [events, decisions, teams] = await Promise.all([
    tx.event.findMany({
      where: { gameId },
      select: { id: true, actorId: true, actionType: true, content: true },
    }),
    tx.decisionJudgment.findMany({
      where: { gameId },
      select: { eventId: true, evaluationRunId: true, evaluationVersion: true },
    }),
    tx.teamJudgment.findMany({
      where: { gameId },
      select: { eventId: true, evaluationRunId: true, evaluationVersion: true },
    }),
  ]);
  if (!evaluationCompleteness({ run, events, judgments: [...decisions, ...teams] }).complete) {
    throw new Error(`对局 ${gameId} 的评分业务投影不完整，无法生成复盘或反思`);
  }
  return run.id;
}
