import { EVALUATION_VERSION } from './evaluation-version';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { evaluationCompleteness } from './evaluation-completeness';
import { readExperiment } from './experiment-snapshot';
import {
  stratifyObservations,
  summarizeObservations,
  summarizeAgentRolePairs,
  type ScoredObservation,
} from './ab-statistics';

const root = resolve(__dirname, '../../../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });
const option = (key: string) =>
  process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const ids = (key: string) => option(key)?.split(',').filter(Boolean) ?? [];

async function main() {
  const experimentId = option('experiment');
  const gameIds = ids('games');
  if (!experimentId && !gameIds.length)
    throw new Error('Use --experiment=<id> or --games=<ids> [--on=<ids> --off=<ids>]');
  const on = new Set(ids('on'));
  const off = new Set(ids('off'));
  const excluded = new Set(ids('exclude'));
  if ([...on].some((id) => off.has(id))) throw new Error('Overlapping ON/OFF assignments');
  if (excluded.size && !option('reason')) throw new Error('--exclude requires --reason');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    const report = await prisma.$transaction(
      async (db) => {
        const games = await db.game.findMany({
          where: experimentId
            ? { experiment: { path: ['experimentId'], equals: experimentId } }
            : { id: { in: gameIds } },
          include: { players: true },
          orderBy: { startedAt: 'asc' },
        });
        if (!games.length || (!experimentId && games.length !== new Set(gameIds).size))
          throw new Error('Requested games missing');
        for (const id of [...on, ...off, ...excluded])
          if (!games.some((g) => g.id === id))
            throw new Error(`Assignment outside selected games: ${id}`);
        const observations: ScoredObservation[] = [];
        const teams: ScoredObservation[] = [];
        const manifest: Array<Record<string, unknown>> = [];
        const readyGames = new Set<string>();
        for (const game of games) {
          const snapshot = readExperiment(game.experiment);
          const manualArm = on.has(game.id) ? 'on' : off.has(game.id) ? 'off' : undefined;
          if (snapshot && manualArm && snapshot.arm !== manualArm)
            throw new Error('Manual grouping conflicts with saved experiment');
          const arm: ScoredObservation['arm'] = snapshot?.arm ?? manualArm ?? 'unknown';
          const [judgments, teamJudgments, events, usageCount, retrievals, contexts, run] =
            await Promise.all([
              db.decisionJudgment.findMany({ where: { gameId: game.id } }),
              db.teamJudgment.findMany({ where: { gameId: game.id } }),
              db.event.findMany({
                where: { gameId: game.id },
                select: {
                  id: true,
                  visibility: true,
                  actionType: true,
                  day: true,
                  actorId: true,
                  content: true,
                },
              }),
              db.knowledgeUsage.count({ where: { gameId: game.id } }),
              db.knowledgeRetrieval.findMany({
                where: { gameId: game.id },
                select: { result: true },
              }),
              db.decisionContext.findMany({
                where: { gameId: game.id },
                select: { eventId: true },
              }),
              db.evaluationRun.findFirst({
                where: { gameId: game.id },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              }),
            ]);
          const completeness = evaluationCompleteness({
            run,
            events,
            judgments: [...judgments, ...teamJudgments],
          });
          const inputEventIds = (run?.expectedEventIds ?? []).flatMap((id) => {
            const event = events.find((e) => e.id === id);
            if (event?.actionType !== 'wolf_kill') return [id];
            const proposalIds = (event.content as Record<string, unknown>).proposalEventIds;
            return Array.isArray(proposalIds) && proposalIds.length
              ? proposalIds.filter((value): value is string => typeof value === 'string')
              : [id];
          });
          const missingInputs = snapshot
            ? inputEventIds.filter((id) => !contexts.some((c) => c.eventId === id))
            : [];
          const valid =
            !snapshot?.invalid &&
            !missingInputs.length &&
            game.status === 'finished' &&
            !excluded.has(game.id);
          const legacy = !snapshot && !run && process.argv.includes('--legacy-descriptive');
          if (valid && completeness.complete) readyGames.add(game.id);
          manifest.push({
            gameId: game.id,
            status: game.status,
            pairId: snapshot?.pairId,
            arm,
            evaluation: completeness,
            evaluationRunId: run?.id,
            invalidExperiment: snapshot?.invalid,
            included: valid && (completeness.complete || legacy),
            groupingSource: snapshot ? 'saved' : manualArm ? 'manual' : 'unknown',
            usageCount,
            excluded: excluded.has(game.id),
            exclusionReason: excluded.has(game.id) ? option('reason') : undefined,
            missingScoredContextIds: snapshot ? missingInputs : undefined,
            repeatedNightDay: events
              .filter((e) => e.actionType === 'wolf_kill')
              .some((e, i, all) => all.findIndex((x) => x.day === e.day) !== i),
            retrievals: retrievals.map((r) => r.result),
          });
          if (!valid || (!completeness.complete && !legacy)) continue;
          for (const j of judgments) {
            if (
              !legacy &&
              (j.evaluationRunId !== run?.id ||
                j.evaluationVersion !== EVALUATION_VERSION ||
                !run.expectedEventIds.includes(j.eventId))
            )
              continue;
            const player = game.players.find((p) => p.id === j.playerId)!;
            observations.push({
              gameId: game.id,
              agentId: player.agentId,
              pairId: snapshot?.pairId,
              arm,
              actionType: j.actionType,
              role: player.role ?? 'unknown',
              faction: player.faction ?? 'unknown',
              model: player.modelName,
              visibility: events.find((e) => e.id === j.eventId)?.visibility ?? 'unknown',
              evaluationVersion: j.evaluationVersion,
              evaluationComplete: completeness.complete ? true : undefined,
              score: j.score,
            });
          }
          for (const j of teamJudgments) {
            if (
              !legacy &&
              (j.evaluationRunId !== run?.id ||
                j.evaluationVersion !== EVALUATION_VERSION ||
                !run.expectedEventIds.includes(j.eventId))
            )
              continue;
            teams.push({
              gameId: game.id,
              pairId: snapshot?.pairId,
              arm,
              actionType: j.actionType,
              role: 'team',
              faction: j.faction,
              model: 'collective',
              visibility: 'wolf_kill',
              evaluationVersion: j.evaluationVersion,
              evaluationComplete: completeness.complete ? true : undefined,
              score: j.score,
            });
          }
        }
        // 一臂失效/未评完时，两臂都不进入正式实验统计，避免把不完整配对混进总均分。
        const eligiblePairIds = new Set(
          games.flatMap((game) => {
            const snapshot = readExperiment(game.experiment);
            if (!snapshot) return [];
            const pair = games.filter(
              (candidate) => readExperiment(candidate.experiment)?.pairId === snapshot.pairId,
            );
            return pair.length === 2 &&
              pair.every((candidate) => readyGames.has(candidate.id)) &&
              new Set(pair.map((candidate) => readExperiment(candidate.experiment)?.arm)).size === 2
              ? [snapshot.pairId]
              : [];
          }),
        );
        for (const rows of [observations, teams])
          for (let i = rows.length - 1; i >= 0; i--)
            if (rows[i].pairId && !eligiblePairIds.has(rows[i].pairId!)) rows.splice(i, 1);
        for (const entry of manifest)
          if (entry.pairId && !eligiblePairIds.has(String(entry.pairId))) {
            entry.included = false;
            entry.pairExclusion = 'pair_incomplete_or_invalid';
          }
        const versions = [...new Set(observations.map((r) => r.evaluationVersion))];
        return {
          note: 'Primary results are pairedByRole: match agent, role, model and action within each pair, average agents within a pair, then weight pairs equally. Overall means and teamStrata are supplementary. Event counts are not independent sample sizes; unmatched actions are not assigned zero scores. Grouping is never inferred from missing usage.',
          pairedByRole: summarizeAgentRolePairs(observations),
          manifest,
          byEvaluationVersion: Object.fromEntries(
            versions.map((v) => [
              v,
              {
                decision: summarizeObservations(
                  observations.filter(
                    (r) => r.evaluationVersion === v && r.actionType !== 'speech',
                  ),
                ),
                speech: summarizeObservations(
                  observations.filter(
                    (r) => r.evaluationVersion === v && r.actionType === 'speech',
                  ),
                ),
              },
            ]),
          ),
          strata: stratifyObservations(observations),
          teamStrata: stratifyObservations(teams),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
    );
    process.stdout.write(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
