import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { VoteTurnCandidate } from '../../src/game-engine/ports/vote-turn.port';
import { VoteTurnAdapter } from '../../src/game-executor/vote-turn.adapter';
import { createMockGame } from '../../src/game-engine/testing/mock-game-harness';
import { MockGameStore } from '../../src/game-engine/testing/mock-game-store';
import type { KnowledgeRetrievalOptions } from '../../src/knowledge/knowledge.service';
import type { Env } from '../../src/config/env.validation';

export async function createVoteFixture(
  prisma: PrismaService,
  existingGameId?: string,
  overrides: Partial<Env> = {},
) {
  await prisma.ruleset.upsert({
    where: { id: 'standard6p' },
    update: {},
    create: {
      id: 'standard6p',
      name: '普通投票隔离测试',
      playerCount: 6,
      definition: new MockGameStore().ruleset.definition,
    },
  });
  const gameId =
    existingGameId ??
    (
      await prisma.game.create({
        data: { rulesetId: 'standard6p', skillVersion: 'v1', status: 'running' },
      })
    ).id;
  if (!existingGameId) {
    const agents = await prisma.agent.createManyAndReturn({
      data: new MockGameStore().players.map((player) => ({
        name: randomUUID(),
        defaultModelName: player.modelName,
        memoryLabel: 'default',
      })),
    });
    await prisma.player.createMany({
      data: new MockGameStore().players.map(
        ({ id: _id, gameId: _gameId, agentId: _agentId, ...player }, index) => ({
          ...player,
          gameId,
          agentId: agents[index].id,
        }),
      ),
    });
  }
  const players = await prisma.player.findMany({ where: { gameId }, orderBy: { seatNo: 'asc' } });
  const game = await createMockGame(
    'villager',
    {
      KNOWLEDGE_INJECTION: true,
      GAME_MAX_DURATION_MS: 600_000,
      ARK_EMBEDDING_MODEL: 'test-embedding',
      ...overrides,
    },
    { prisma, gameId, recovery: true },
  );
  const chunk = await prisma.knowledgeChunk.create({
    data: {
      sourceFile: 'test.md',
      articleTitle: '公开信息归票',
      sectionTitle: '普通投票',
      role: 'any',
      scenario: 'vote',
      trigger: '公开投票',
      action: '基于已公开信息投票',
      content: '不要引用尚未提交的行动。',
    },
  });
  game.knowledge.retrieve.mockImplementation(async (...args: unknown[]) => {
    const options = args[3] as KnowledgeRetrievalOptions;
    const retrieval = await prisma.knowledgeRetrieval.create({
      data: {
        gameId,
        playerId: options.playerId!,
        query: String(args[0]),
        result: { injected: [chunk.id] },
      },
    });
    options.onAudit?.(retrieval.id);
    return [{ ...chunk, similarity: 1 }];
  });
  const adapter = new VoteTurnAdapter(game.runtime);
  const generate = async () => {
    const visibleThrough = await adapter.visibleThrough(gameId);
    return Promise.all(
      players.map((player) =>
        adapter.vote({
          gameId,
          phaseInstanceId: 'node/0/vote',
          playerId: player.id,
          seatNo: player.seatNo!,
          day: 1,
          phase: '普通投票',
          round: 0,
          aliveSeatNos: players.map((p) => p.seatNo!),
          legalSeatNos: players.map((p) => p.seatNo!),
          visibleThrough,
        }),
      ),
    );
  };
  return { game, gameId, players, generate, chunk };
}

export function voteBatch(turns: VoteTurnCandidate[], signal?: AbortSignal) {
  const first = turns[0].reference;
  return {
    gameId: first.gameId,
    phaseInstanceId: first.phaseInstanceId,
    day: first.day,
    signal,
    expectedActorIds: turns.map((turn) => turn.reference.playerId),
    turns,
    sources: Object.fromEntries(turns.map((turn) => [turn.reference.playerId, turn.source])),
    votes: turns.map(({ reference, reasoning }) => ({
      actorId: reference.playerId,
      voterSeatNo: reference.seatNo,
      targetSeatNo: reference.action.action === 'cast_vote' ? reference.action.targetSeatNo : 0,
      thinking: reasoning,
    })),
  };
}
