import { createTestExecution, nextTestExecution } from './helpers/execution-fixture';
import { randomUUID } from 'node:crypto';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import {
  ExecutionOwnershipError,
  GameRecoveryService,
} from '../src/game-recovery/game-recovery.service';
import type { Prisma } from '../src/generated/prisma/client';
import { GameEngine } from '../src/game-engine/core/game-engine';
import { NodeRegistry } from '../src/game-engine/nodes/node-registry';
import { VoteNode } from '../src/game-engine/nodes/day/vote.node';
import { PkVoteNode } from '../src/game-engine/nodes/day/pk-vote.node';
import { wolfVoting } from '../src/game-engine/nodes/night/werewolf-collaboration';
import type { NodeContext } from '../src/game-engine/nodes/node.types';
import { ModelCallError } from '../src/llm/model-call-guard';
import { createGameState, createPlayer } from '../src/game-engine/testing/test-utils';
import type { VoteTurnPort } from '../src/game-engine/ports/vote-turn.port';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { GamesService } from '../src/games/games.service';

describe('领域提交协议：真实隔离 PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let recovery: GameRecoveryService;
  let writer: EventWriterService;
  let gameId: string;
  let actorId: string;
  let otherId: string;

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
    await prisma.ruleset.create({
      data: { id: 'submission-test', name: '提交协议测试', playerCount: 1, definition: {} },
    });
  });
  afterAll(async () => database?.close());
  beforeEach(async () => {
    gameId = (
      await prisma.game.create({
        data: { rulesetId: 'submission-test', skillVersion: 'test', status: 'running' },
      })
    ).id;
    const agent = await prisma.agent.create({
      data: { name: randomUUID(), defaultModelName: 'mock', memoryLabel: 'test' },
    });
    actorId = (
      await prisma.player.create({
        data: {
          gameId,
          agentId: agent.id,
          seatNo: 1,
          displayName: '测试玩家',
          modelName: 'mock',
          memoryLabelSnapshot: 'test',
        },
      })
    ).id;
    const otherAgent = await prisma.agent.create({
      data: { name: randomUUID(), defaultModelName: 'mock', memoryLabel: 'test' },
    });
    otherId = (
      await prisma.player.create({
        data: {
          gameId,
          agentId: otherAgent.id,
          seatNo: 2,
          displayName: '第二位测试玩家',
          modelName: 'mock',
          memoryLabelSnapshot: 'test',
        },
      })
    ).id;
    recovery = new GameRecoveryService(prisma);
    writer = new EventWriterService(prisma, recovery);
  });

  const submission = (targetSeatNo = 2) => ({
    gameId,
    phaseInstanceId: 'node/7/werewolfKill',
    day: 1,
    actorId,
    actionType: 'wolf_proposal' as const,
    content: { targetSeatNo, seatNo: 1, thinking: '依据已知信息决定' },
  });
  const saved = () => prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } });
  it('提交响应丢失后保留原产物来源，新生成的相同内容不能替换采用来源', async () => {
    const source = {
      actionKey: JSON.stringify([gameId, 'node/7/werewolfKill', 'wolf_proposal', actorId, 0]),
      traceId: 'a'.repeat(32),
      attemptId: randomUUID(),
      startedAt: new Date().toISOString(),
      outputObservationId: randomUUID(),
    };
    const first = await writer.writeWolfDecisionEvent({ ...submission(), source } as never);
    const replayed = await writer.writeWolfDecisionEvent({
      ...submission(),
      source: { ...source, attemptId: randomUUID() },
    } as never);
    expect(replayed.id).toBe(first.id);
    expect((replayed as any).source).toEqual(source);
  });
  const batches = () => prisma.effectBatchCommit.findMany({ where: { gameId } });
  const batch = () => ({
    gameId,
    phaseInstanceId: 'node/8/vote',
    day: 1,
    expectedActorIds: [actorId, otherId],
    votes: [
      { actorId, voterSeatNo: 1, targetSeatNo: 2 },
      { actorId: otherId, voterSeatNo: 2, targetSeatNo: 0 },
    ],
  });
  async function runner(recoverable: boolean) {
    const execution = recoverable
      ? await createTestExecution(
          prisma,
          gameId,
          {},
          { version: 1, prompts: {} },
          new Date(Date.now() + 60_000),
        )
      : undefined;
    return async <T>(action: () => Promise<T>) =>
      execution
        ? recovery.run(
            await nextTestExecution(prisma, execution.gameId),
            new AbortController().signal,
            action,
          )
        : action();
  }

  it('同一动作并发提交只产生一个结果并返回原事件 ID', async () => {
    const results = await Promise.all([
      writer.writeWolfDecisionEvent(submission()),
      writer.writeWolfDecisionEvent(submission()),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await saved()).toHaveLength(1);
  });

  it('单项提交后即使未调用发布，也已持久保存可补送的原事件', async () => {
    const event = await writer.writeWolfDecisionEvent(submission());
    const [table] = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('event_delivery_outbox')::text AS name
    `;
    const pending = table.name
      ? await prisma.$queryRaw<Array<{ event_ids: string[] }>>`
          SELECT event_ids FROM event_delivery_outbox WHERE game_id = ${gameId}::uuid
        `
      : [];
    expect(pending).toEqual([expect.objectContaining({ event_ids: [event.id] })]);
  });

  it('取消读取旧状态后与正常终局并发，不能覆盖已提交胜负或发送伪终态', async () => {
    const broadcaster = { emit: jest.fn(), complete: jest.fn() };
    const executor = { abortGame: jest.fn() };
    const service = new GamesService(prisma, executor as never, broadcaster as never, {} as never);
    jest.spyOn(service, 'getGameById').mockImplementationOnce(async () => {
      const stale = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      await writer.writeGameEndEvent({
        gameId,
        phaseInstanceId: 'node/50/gameEnd',
        winner: 'villager',
        winnerFaction: 'villager',
        totalDays: 1,
      });
      return stale as never;
    });
    await expect(service.cancelGame(gameId)).rejects.toThrow('无法取消');
    expect(await prisma.game.findUnique({ where: { id: gameId } })).toMatchObject({
      status: 'finished',
      winnerFaction: 'villager',
    });
    expect(executor.abortGame).not.toHaveBeenCalled();
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  it.each([false, true])('同键不同内容拒绝且原记录不变（恢复=%s）', async (recoverable) => {
    const execution = recoverable
      ? await createTestExecution(
          prisma,
          gameId,
          {},
          { version: 1, prompts: {} },
          new Date(Date.now() + 60_000),
        )
      : undefined;
    const run = async <T>(action: () => Promise<T>) =>
      execution
        ? recovery.run(
            await nextTestExecution(prisma, execution.gameId),
            new AbortController().signal,
            action,
          )
        : action();
    await run(() => writer.writeWolfDecisionEvent(submission()));
    const original = await saved();
    await expect(run(() => writer.writeWolfDecisionEvent(submission(3)))).rejects.toThrow(/冲突/);
    expect(await saved()).toEqual(original);
  });

  it('普通投票批次响应丢失后的重试返回同一批事件 ID', async () => {
    const input = {
      gameId,
      phaseInstanceId: 'node/8/vote',
      day: 1,
      expectedActorIds: [actorId],
      votes: [{ actorId, voterSeatNo: 1, targetSeatNo: 0 }],
    };
    await writer.writeVoteBatch(input);
    const original = await saved();
    await writer.writeVoteBatch(input);
    expect((await saved()).map((event) => event.id)).toEqual(original.map((event) => event.id));
  });

  it.each([false, true])(
    '批次并发、重排重试与内容冲突均由同一协议仲裁（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      const input = batch();
      const results = await run(() =>
        Promise.all([writer.writeVoteBatch(input), writer.writeVoteBatch(input)]),
      );
      expect(results[0].map((event) => event.id)).toEqual(results[1].map((event) => event.id));
      const original = await saved();
      const retried = await run(() =>
        writer.writeVoteBatch({
          ...input,
          votes: input.votes.toReversed().map((vote) => ({ ...vote, voteRound: 0 })),
          expectedActorIds: input.expectedActorIds.toReversed(),
        }),
      );
      expect(retried.map((event) => event.id)).toEqual(original.map((event) => event.id));
      expect(retried.every((event) => event.replayed)).toBe(true);
      await expect(
        run(() =>
          writer.writeVoteBatch({
            ...input,
            votes: input.votes.map((vote) => ({ ...vote, thinking: '改变了提交理由' })),
          }),
        ),
      ).rejects.toThrow('冲突');
      expect(await saved()).toEqual(original);
      expect(await batches()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    '批内第二项失败时所有事件及完成记录回滚（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      await prisma.$executeRawUnsafe(
        'ALTER TABLE events ADD CONSTRAINT submission_reject_second CHECK (sequence <> 2) NOT VALID',
      );
      try {
        await expect(run(() => writer.writeVoteBatch(batch()))).rejects.toThrow(
          'submission_reject_second',
        );
        expect(await saved()).toHaveLength(0);
        expect(await batches()).toHaveLength(0);
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE events DROP CONSTRAINT submission_reject_second',
        );
      }
      expect(await run(() => writer.writeVoteBatch(batch()))).toHaveLength(2);
    },
  );

  it.each([false, true])(
    '数据库已提交但响应丢失，重试取得原 ID（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      const transact = prisma.$transaction.bind(prisma);
      const injection = jest.spyOn(prisma, '$transaction').mockImplementation((async (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        const result = await transact(callback);
        if (await prisma.event.count({ where: { gameId } })) throw new Error('提交响应丢失');
        return result;
      }) as never);
      try {
        await expect(run(() => writer.writeVoteBatch(batch()))).rejects.toThrow('提交响应丢失');
      } finally {
        injection.mockRestore();
      }
      const original = await saved();
      expect(original).toHaveLength(2);
      const retry = await run(() => writer.writeVoteBatch(batch()));
      expect(retry.map((event) => event.id)).toEqual(original.map((event) => event.id));
      expect(retry.every((event) => event.replayed)).toBe(true);
      expect(await batches()).toHaveLength(1);
    },
  );

  it.each([false, true])('零事件批次记完成，后续投票不能替换它（恢复=%s）', async (recoverable) => {
    const run = await runner(recoverable);
    const input = { ...batch(), expectedActorIds: [], votes: [] };
    expect(await run(() => writer.writeVoteBatch(input))).toEqual([]);
    const original = await batches();
    expect(original).toHaveLength(1);
    expect(original[0].eventIds).toEqual([]);
    expect(await run(() => writer.writeVoteBatch(input))).toEqual([]);
    await expect(run(() => writer.writeVoteBatch(batch()))).rejects.toThrow('冲突');
    expect(await saved()).toHaveLength(0);
    expect(await batches()).toEqual(original);
  });

  it.each(['遗漏', '额外', '重复', '错位'] as const)('批次参与者%s时没有任何写入', async (kind) => {
    const input = batch();
    if (kind === '遗漏') input.votes.pop();
    if (kind === '额外') input.expectedActorIds.pop();
    if (kind === '重复') input.votes.push(input.votes[0]);
    if (kind === '错位') input.votes[0].voterSeatNo = 2;
    await expect(writer.writeVoteBatch(input)).rejects.toThrow();
    expect(await saved()).toHaveLength(0);
    expect(await batches()).toHaveLength(0);
  });

  it.each([false, true])(
    '取消会回滚整批，命中缓存后取消也拒绝返回（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      const controller = new AbortController();
      const transact = prisma.$transaction.bind(prisma);
      const injection = jest.spyOn(prisma, '$transaction').mockImplementation((async (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        transact(async (tx) => {
          const create = tx.effectBatchCommit.create.bind(tx.effectBatchCommit);
          return callback(
            new Proxy(tx, {
              get(target, key) {
                if (key !== 'effectBatchCommit') return Reflect.get(target, key);
                return {
                  ...tx.effectBatchCommit,
                  create: async (args: Parameters<typeof create>[0]) => {
                    const result = await create(args);
                    controller.abort(new Error('提交中取消'));
                    return result;
                  },
                };
              },
            }),
          );
        })) as never);
      try {
        await expect(
          run(() => writer.writeVoteBatch({ ...batch(), signal: controller.signal })),
        ).rejects.toThrow('提交中取消');
      } finally {
        injection.mockRestore();
      }
      expect(await saved()).toHaveLength(0);
      expect(await batches()).toHaveLength(0);
      await run(() => writer.writeVoteBatch(batch()));
      await expect(
        run(() => writer.writeVoteBatch({ ...batch(), signal: controller.signal })),
      ).rejects.toThrow('提交中取消');
      expect(await saved()).toHaveLength(2);
    },
  );

  it('旧执行代次即使命中动作或批次缓存也不能提交', async () => {
    const run = await runner(true);
    await run(() => writer.writeWolfDecisionEvent(submission()));
    await run(() => writer.writeVoteBatch(batch()));
    const original = await saved();
    await run(async () => {
      await recovery.interrupt(gameId, recovery.current!.execution.generation);
      await expect(writer.writeWolfDecisionEvent(submission())).rejects.toBeInstanceOf(
        ExecutionOwnershipError,
      );
      await expect(writer.writeVoteBatch(batch())).rejects.toBeInstanceOf(ExecutionOwnershipError);
    });
    expect(await saved()).toEqual(original);
  });

  it.each([false, true])(
    '引擎同日 vote→pkVote→vote 分配不同实例，恢复重走不重复（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      const voteTurn: VoteTurnPort = {
        visibleThrough: async () => 0,
        vote: async (request) => ({
          reasoning: '弃票',
          reference: { ...request, action: { action: 'abstain' } },
          source: {
            actionKey: JSON.stringify([
              request.gameId,
              request.phaseInstanceId,
              'vote',
              request.playerId,
              0,
            ]),
            attemptId: request.playerId,
            traceId: 'trace',
            outputObservationId: 'output',
            startedAt: '2026-09-16T00:00:00Z',
          },
          attribution: {
            snapshot: { scenario: 'vote' },
            memoryUsages: [],
            knowledgeUsages: [],
            experiment: false,
          },
        }),
      };
      const registry = new NodeRegistry({
        vote: new VoteNode().create(),
        pkVote: () => async () => ({}),
      });
      const initial = createGameState({
        gameId,
        players: [createPlayer(actorId, 1), createPlayer(otherId, 2)],
      });
      const execute = async () => {
        const engine = new GameEngine(
          {} as never,
          voteTurn,
          prisma,
          writer,
          {} as never,
          registry,
          { publish: async () => {} } as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          recoverable ? recovery : undefined,
        );
        const boundary = engine as unknown as {
          executeNode: (name: string, state: typeof initial) => Promise<typeof initial>;
        };
        let state = initial;
        for (const node of ['vote', 'pkVote', 'vote'])
          state = await boundary.executeNode(node, state);
        return state;
      };
      await run(execute);
      const original = await saved();
      expect(original).toHaveLength(4);
      expect(new Set(original.map((event) => event.effectKey)).size).toBe(4);
      expect(await batches()).toHaveLength(2);
      await run(execute);
      expect(await saved()).toEqual(original);
    },
  );

  describe.each(['PK', '狼队'] as const)('%s 节点接入', (kind) => {
    it.each([false, true])(
      '收集、提交及归因失败保持批次边界，重试复用原 ID（恢复=%s）',
      async (recoverable) => {
        const run = await runner(recoverable);
        const agent = await prisma.agent.create({
          data: {
            name: randomUUID(),
            defaultModelName: 'mock',
            memoryLabel: 'test',
          },
        });
        const target = await prisma.player.create({
          data: {
            gameId,
            agentId: agent.id,
            seatNo: 3,
            displayName: '候选目标',
            modelName: 'mock',
            memoryLabelSnapshot: 'test',
          },
        });
        const state = createGameState(
          {
            gameId,
            players: [
              createPlayer(actorId, 1, 'werewolf', 'werewolf'),
              createPlayer(otherId, 2, 'werewolf', 'werewolf'),
              createPlayer(target.id, 3, 'villager', 'villager'),
            ],
          },
          {
            phaseInstanceId: `node/8/${kind === 'PK' ? 'pkVote' : 'werewolfKill'}`,
            pkCandidates: [3],
            pkRound: 1,
          },
        );
        let collectionFails = true;
        let reasoning = '投给3号';
        const runtime = {
          prepareContextPublic: jest.fn(async ({ playerId }: { playerId: string }) => ({
            playerId,
          })),
          decide: jest.fn(async ({ playerId }: { playerId: string }) => {
            if (collectionFails && playerId === otherId) throw new Error('第二位收集失败');
            return { reasoning, decision: { action: 'propose_kill', targetSeatNo: 3 } };
          }),
          recordExperienceUsages: jest.fn().mockResolvedValue(undefined),
        };
        const context = {
          agentRuntime: runtime,
          eventWriter: writer,
          eventBus: { publish: jest.fn() },
          ...(recoverable ? { recovery } : {}),
        } as unknown as NodeContext;
        const node: () => Promise<unknown> =
          kind === 'PK'
            ? () => new PkVoteNode(runtime as never).create()(context)(state)
            : () => wolfVoting(state.players.slice(0, 2), state, context);
        await expect(run(node)).rejects.toThrow('第二位收集失败');
        expect(await saved()).toHaveLength(0);
        expect(await batches()).toHaveLength(0);

        collectionFails = false;
        await prisma.$executeRawUnsafe(
          'ALTER TABLE events ADD CONSTRAINT submission_node_second CHECK (sequence <> 2) NOT VALID',
        );
        try {
          await expect(run(node)).rejects.toThrow('submission_node_second');
          expect(await saved()).toHaveLength(0);
          expect(await batches()).toHaveLength(0);
        } finally {
          await prisma.$executeRawUnsafe(
            'ALTER TABLE events DROP CONSTRAINT submission_node_second',
          );
        }

        runtime.recordExperienceUsages.mockRejectedValueOnce(new ModelCallError('transient'));
        await expect(run(node)).rejects.toThrow();
        const committed = await saved();
        expect(committed).toHaveLength(2);
        expect(await batches()).toHaveLength(1);
        await run(node);
        expect(await saved()).toEqual(committed);
        // 归因按参与者绑定，不受数据库按业务键排序影响。
        for (const [request, event] of runtime.recordExperienceUsages.mock.calls)
          expect(event.actorId).toBe(request.playerId);
        reasoning = '重试改变了理由';
        await expect(run(node)).rejects.toThrow('冲突');
        expect(await saved()).toEqual(committed);
      },
    );
  });

  it('PK 无投票者也持久化零事件批次，重试只返回原完成记录', async () => {
    const runtime = { decide: jest.fn() };
    const state = createGameState(
      { gameId, players: [createPlayer(actorId, 1), createPlayer(otherId, 2)] },
      { phaseInstanceId: 'node/8/pkVote', pkCandidates: [1, 2], pkRound: 1 },
    );
    const node = new PkVoteNode(runtime as never).create()({ eventWriter: writer } as NodeContext);
    await node(state);
    const original = await batches();
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ eventIds: [], outcomes: [] });
    await node(state);
    expect(await batches()).toEqual(original);
    expect(await saved()).toHaveLength(0);
    expect(runtime.decide).not.toHaveBeenCalled();
  });

  it('旧逐票检查点缺少业务键时拒绝转换，不补写另一批', async () => {
    const run = await runner(true);
    const scope = { gameId, phaseInstanceId: 'node/8/pkVote', day: 1 };
    const node = (action: () => Promise<unknown>) => recovery.node(8, 'pkVote', {}, action);
    await expect(
      run(() =>
        node(async () => {
          await recovery.effect(`event/vote/${actorId}`, (tx) =>
            tx.event.create({
              data: {
                gameId,
                sequence: 1,
                day: 1,
                phase: 'vote',
                actionType: 'vote',
                actorId,
                content: { voterSeatNo: 1, targetSeatNo: 2 },
              },
            }),
          );
          throw new Error('旧版逐票提交后中断');
        }),
      ),
    ).rejects.toThrow('旧版逐票提交后中断');
    const original = await saved();
    await expect(
      run(() => node(() => writer.writeVoteBatch({ ...batch(), ...scope }))),
    ).rejects.toThrow('旧逐条提交');
    expect(await saved()).toEqual(original);
    expect(await batches()).toHaveLength(0);
  });

  it('已有单项投票不能被批次再次声明', async () => {
    // 旧逐票提交留下的 Event：它的业务键与批次子效果同形，批次必须据此拒绝。
    await prisma.event.create({
      data: {
        gameId,
        sequence: 1,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        actorId,
        effectKey: JSON.stringify([gameId, 'node/8/vote', 'vote', actorId, 0]),
        content: { voterSeatNo: 1, targetSeatNo: 2 },
      },
    });
    const original = await saved();
    await expect(
      writer.writeVoteBatch({ ...batch(), expectedActorIds: [actorId], votes: [batch().votes[0]] }),
    ).rejects.toThrow('冲突');
    expect(await saved()).toEqual(original);
    expect(await batches()).toHaveLength(0);
  });

  it.each([false, true])(
    '终局同一执行内重试返回原事件，仍拒绝新增其他效果（恢复=%s）',
    async (recoverable) => {
      const run = await runner(recoverable);
      await run(async () => {
        const input = {
          gameId,
          phaseInstanceId: 'node/30/gameEnd',
          winner: 'villager',
          winnerFaction: 'villager',
          totalDays: 2,
        };
        const first = await writer.writeGameEndEvent(input);
        const second = await writer.writeGameEndEvent(input);
        expect(second).toMatchObject({ id: first.id, replayed: true });
        await expect(writer.writeGameEndEvent({ ...input, totalDays: 3 })).rejects.toThrow('冲突');
        await expect(writer.writeWolfDecisionEvent(submission())).rejects.toThrow('不允许新增');
      });
      expect(await saved()).toHaveLength(1);
    },
  );
});

it('正式迁移兼容旧事件和评分，原字段保持不变，新增来源不冒标', async () => {
  let historical: Record<string, unknown>[] = [];
  const database = await createLearningTestDatabase({
    beforeMigration: {
      name: '20260914035600_domain_submission_protocol',
      run: async (client) => {
        await client.query(
          "INSERT INTO rulesets(id,name,player_count,definition) VALUES ('legacy','历史规则',1,'{}')",
        );
        const gameId = randomUUID();
        await client.query(
          "INSERT INTO games(id,ruleset_id,skill_version) VALUES ($1,'legacy','test')",
          [gameId],
        );
        for (const sequence of [1, 2])
          await client.query(
            "INSERT INTO events(id,game_id,sequence,day,phase,action_type,content) VALUES ($1,$2,$3,1,'vote','vote',$4)",
            [randomUUID(), gameId, sequence, JSON.stringify({ targetSeatNo: 0 })],
          );
        historical = (await client.query('SELECT * FROM events ORDER BY sequence')).rows;
        await client.query(
          "INSERT INTO evaluation_runs(id,game_id,expected_event_ids,status) VALUES ('legacy-run',$1,$2,'complete')",
          [gameId, historical.map((event) => event.id)],
        );
      },
    },
  });
  try {
    const current = await database.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT * FROM events ORDER BY sequence',
    );
    expect(
      current.map(({ effect_key, payload_hash, source, ...event }) => {
        expect(effect_key).toBeNull();
        expect(payload_hash).toBeNull();
        expect(source).toBeNull();
        return event;
      }),
    ).toEqual(historical);
    expect(
      await database.db.evaluationRun.findUniqueOrThrow({ where: { id: 'legacy-run' } }),
    ).toMatchObject({
      status: 'complete',
      definition: null,
      selection: null,
      pendingResults: {},
      deliveredEventIds: [],
    });
  } finally {
    await database.close();
  }
});
