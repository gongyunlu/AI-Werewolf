import { Prisma } from '@/generated/prisma/client';
import { decodeRecoveryValue } from '@/game-recovery/recovery-value';
import {
  VoteTurnBindingError,
  type CommittedVoteEvent,
  type VoteTurnCandidate,
  type VoteTurnReference,
} from '../ports/vote-turn.port';
import { submissionHash, type SubmissionScope } from './submission-protocol';

export function assertVoteEventMatches(
  reference: VoteTurnReference,
  event: Omit<CommittedVoteEvent, 'id'>,
): void {
  const content = event.content as Record<string, unknown>;
  if (
    event.actionType !== 'vote' ||
    event.gameId !== reference.gameId ||
    event.actorId !== reference.playerId ||
    event.day !== reference.day ||
    (content.voteRound ?? 0) !== reference.round ||
    content.voterSeatNo !== reference.seatNo ||
    content.targetSeatNo !==
      (reference.action.action === 'cast_vote' ? reference.action.targetSeatNo : 0)
  )
    throw new VoteTurnBindingError('投票事件与本次请求不符');
}

export function voteAttributionHash(turn: VoteTurnCandidate): string {
  return submissionHash({ reference: turn.reference, attribution: turn.attribution });
}

/** 旧批次尚无归因摘要，只能用原执行日志证明补写资料，不能信任后来传入的同名来源。 */
async function verifyLegacyVoteAttributions(
  tx: Prisma.TransactionClient,
  scope: SubmissionScope,
  turns: VoteTurnCandidate[],
) {
  const contextKey = (actorId: string) => `${scope.phaseInstanceId}/context/${actorId}/0`;
  const decisionKey = (actorId: string) => `${scope.phaseInstanceId}/decision/${actorId}/0`;
  const steps = await tx.gameExecutionStep.findMany({
    where: {
      gameId: scope.gameId,
      key: {
        in: [
          scope.phaseInstanceId,
          ...turns.flatMap((turn) => [
            contextKey(turn.reference.playerId),
            decisionKey(turn.reference.playerId),
          ]),
        ],
      },
    },
  });
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const node = byKey.get(scope.phaseInstanceId);
  const input = node ? decodeRecoveryValue<{ visibleThrough: number }>(node.input) : undefined;
  for (const turn of turns) {
    const context = byKey.get(contextKey(turn.reference.playerId));
    const decision = byKey.get(decisionKey(turn.reference.playerId));
    if (!input || !context?.completed || !decision?.completed)
      throw new VoteTurnBindingError('旧投票缺少冻结归因证据，不能安全补齐');
    const prepared = decodeRecoveryValue<{
      ok: boolean;
      value: {
        pendingMemoryUsages: unknown;
        pendingKnowledgeUsages: unknown;
        retrievalId?: string;
        experiment?: unknown;
      };
    }>(context.output);
    const generated = decodeRecoveryValue<{
      ok: boolean;
      value: { source: unknown; replay: unknown; result: { reasoning: string } };
    }>(decision.output);
    const attribution =
      prepared.ok && generated.ok
        ? {
            snapshot: generated.value.replay,
            memoryUsages: prepared.value.pendingMemoryUsages,
            knowledgeUsages: prepared.value.pendingKnowledgeUsages,
            retrievalId: prepared.value.retrievalId,
            experiment: Boolean(prepared.value.experiment),
          }
        : null;
    if (
      !attribution ||
      input.visibleThrough !== turn.reference.visibleThrough ||
      generated.value.result.reasoning !== turn.reasoning ||
      submissionHash(generated.value.source) !== submissionHash(turn.source) ||
      submissionHash(JSON.parse(JSON.stringify(attribution))) !== submissionHash(turn.attribution)
    )
      throw new VoteTurnBindingError('旧投票归因与冻结产物不符');
  }
}

/** 同一事务内严格采用；旧批次只允许补齐同一来源尚未写入的记录。 */
export async function persistVoteAttributions(
  tx: Prisma.TransactionClient,
  scope: SubmissionScope,
  events: CommittedVoteEvent[],
  turns: VoteTurnCandidate[],
  legacy = false,
): Promise<void> {
  const game = await tx.game.findUniqueOrThrow({
    where: { id: scope.gameId },
    select: { experiment: true },
  });
  if (turns.some((turn) => turn.attribution.experiment !== (game.experiment !== null)))
    throw new VoteTurnBindingError('投票产物的实验身份与对局不符');
  const eventByActor = new Map(events.map((event) => [event.actorId, event]));
  const snapshots: Prisma.DecisionContextCreateManyInput[] = [];
  const memories: Prisma.MemoryUsageCreateManyInput[] = [];
  const knowledge: Prisma.KnowledgeUsageCreateManyInput[] = [];
  const retrievals: Prisma.Sql[] = [];
  for (const turn of turns) {
    const event = eventByActor.get(turn.reference.playerId)!;
    assertVoteEventMatches(turn.reference, event);
    const { snapshot, memoryUsages, knowledgeUsages, retrievalId, experiment } = turn.attribution;
    const identity = { gameId: event.gameId, playerId: event.actorId!, eventId: event.id };
    snapshots.push({ ...identity, snapshot: snapshot as Prisma.InputJsonObject });
    const usage = { ...identity, day: event.day!, scenario: 'vote', actionType: 'vote' };
    if (!experiment) memories.push(...memoryUsages.map((row) => ({ ...row, ...usage })));
    knowledge.push(...knowledgeUsages.map((row) => ({ ...row, ...usage })));
    if (retrievalId)
      retrievals.push(
        Prisma.sql`(${retrievalId}::uuid, ${event.id}::uuid, ${event.gameId}::uuid, ${event.actorId}::uuid)`,
      );
  }
  if (legacy) {
    await verifyLegacyVoteAttributions(tx, scope, turns);
    const eventIds = events.map((event) => event.id);
    const [existingSnapshots, existingMemories, existingKnowledge] = await Promise.all([
      tx.decisionContext.findMany({
        where: { eventId: { in: eventIds } },
        select: { eventId: true, gameId: true, playerId: true, snapshot: true },
      }),
      tx.memoryUsage.findMany({
        where: { eventId: { in: eventIds } },
        select: {
          memoryId: true,
          eventId: true,
          gameId: true,
          playerId: true,
          day: true,
          scenario: true,
          actionType: true,
          triggerMatched: true,
        },
      }),
      tx.knowledgeUsage.findMany({
        where: { eventId: { in: eventIds } },
        select: {
          chunkId: true,
          eventId: true,
          gameId: true,
          playerId: true,
          day: true,
          scenario: true,
          actionType: true,
        },
      }),
    ]);
    for (const [existing, proposed] of [
      [existingSnapshots, snapshots],
      [existingMemories, memories],
      [existingKnowledge, knowledge],
    ] as const) {
      const hashes = new Set(proposed.map(submissionHash));
      if (existing.some((row) => !hashes.has(submissionHash(row))))
        throw new VoteTurnBindingError('旧投票归因与冻结产物不符');
    }
  }
  await tx.decisionContext.createMany({ data: snapshots, skipDuplicates: legacy });
  if (memories.length) await tx.memoryUsage.createMany({ data: memories, skipDuplicates: legacy });
  if (knowledge.length)
    await tx.knowledgeUsage.createMany({ data: knowledge, skipDuplicates: legacy });
  if (retrievals.length) {
    const linked = await tx.$executeRaw`
      UPDATE knowledge_retrievals AS r SET event_id = v.event_id
      FROM (VALUES ${Prisma.join(retrievals)}) AS v(id, event_id, game_id, player_id)
      WHERE r.id = v.id AND r.game_id = v.game_id AND r.player_id = v.player_id
        AND (r.event_id IS NULL OR r.event_id = v.event_id)
    `;
    if (linked !== retrievals.length) throw new VoteTurnBindingError('检索记录与投票采用来源不符');
  }
}
