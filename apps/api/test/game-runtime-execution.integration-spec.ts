import { Logger } from '@nestjs/common';
import { emptyCheckpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { UnrecoverableError } from 'bullmq';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GameExecution } from '../src/generated/prisma/client';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import { VoteTurnAdapter } from '../src/game-executor/vote-turn.adapter';
import { GameRuntimeService } from '../src/game-runtime/game-runtime.service';
import { PrismaCheckpointSaver } from '../src/game-runtime/prisma-checkpoint-saver';
import { GameRecoveryService } from '../src/game-recovery/game-recovery.service';
import { ExecutionOwnershipError } from '../src/game-recovery/execution-fence';
import { decodeRecoveryValue } from '../src/game-recovery/recovery-value';
import { createStageRecordStore } from '../src/game-recovery/stage-record-store';
import type { ModelStageState } from '../src/llm/model-stage';
import type { PreparedTurnInput } from '../src/agent-runtime/agent-runtime.service';
import { PLAYER_TURN_PROMPT_NAMES } from '../src/observability/prompt-templates';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { createTestExecution } from './helpers/execution-fixture';
import { createVoteFixture, voteBatch } from './helpers/vote-fixture';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

const metadata: CheckpointMetadata = { source: 'update', step: 0, parents: {} };

describe('图执行沿用真实领取、换代与原期限', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let fixture: Awaited<ReturnType<typeof createVoteFixture>>;
  let recovery: GameRecoveryService;
  let runtime: GameRuntimeService;

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  });
  afterAll(async () => database?.close());
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('执行控制测试禁止外部请求'));
    // 故障由执行期限或失权屏障触发，单次超时不能先终结在途请求。
    fixture = await createVoteFixture(prisma, undefined, {
      LLM_CALL_TIMEOUT_MS: 30_000,
      LLM_FIRST_CHUNK_TIMEOUT_MS: 30_000,
      LLM_STREAM_MAX_DURATION_MS: 30_000,
    });
    recovery = fixture.game.recovery!;
    runtime = new GameRuntimeService(
      prisma,
      new EventWriterService(prisma, recovery),
      new VoteTurnAdapter(fixture.game.runtime),
      recovery,
    );
  });
  afterEach(async () => {
    await fixture?.game.close();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  async function prepare(duration = 600_000) {
    return createTestExecution(
      prisma,
      fixture.gameId,
      {},
      {
        version: 2,
        prompts: await fixture.game.prompts.captureGameSnapshot(
          fixture.gameId,
          PLAYER_TURN_PROMPT_NAMES,
        ),
      },
      new Date(Date.now() + duration),
    );
  }

  function round(execution: GameExecution, phaseInstanceId = 'node/0/vote') {
    return {
      execution,
      phaseInstanceId,
      day: 1,
      voters: fixture.players.map((player) => ({
        playerId: player.id,
        seatNo: player.seatNo!,
        aliveSeatNos: fixture.players.map((entry) => entry.seatNo!),
        legalSeatNos: fixture.players.map((entry) => entry.seatNo!),
      })),
      signal: new AbortController().signal,
    };
  }

  function identity() {
    const scope = recovery.current!;
    return {
      gameId: scope.execution.gameId,
      generation: scope.execution.generation,
      owner: scope.owner,
    };
  }

  async function facts() {
    const gameId = fixture.gameId;
    return {
      events: await prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } }),
      batches: await prisma.effectBatchCommit.findMany({ where: { gameId } }),
      contexts: await prisma.decisionContext.findMany({
        where: { gameId },
        orderBy: { eventId: 'asc' },
      }),
      memory: await prisma.memoryUsage.findMany({
        where: { event: { gameId } },
        orderBy: { id: 'asc' },
      }),
      knowledge: await prisma.knowledgeUsage.findMany({
        where: { event: { gameId } },
        orderBy: { id: 'asc' },
      }),
      outbox: await prisma.eventDeliveryOutbox.findMany({
        where: { gameId },
        orderBy: { firstSequence: 'asc' },
      }),
      steps: await prisma.gameExecutionStep.findMany({
        where: { gameId },
        orderBy: { key: 'asc' },
      }),
      checkpoints: await prisma.graphCheckpoint.findMany({
        where: { gameId },
        orderBy: { checkpointId: 'asc' },
      }),
      writes: await prisma.graphCheckpointWrite.findMany({
        where: { gameId },
        orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
      }),
    };
  }

  it('两个独立执行者从空 owner 同时领取，只有赢家进入执行回调并采用一批投票', async () => {
    const execution = await prepare();
    // 候选在测试准备时固定，这个用例只验证领取仲裁与唯一采用。
    const candidates = await fixture.generate();
    const requested = fixture.game.model.requests.length;
    expect(execution).toMatchObject({ owner: null, dispatchPending: true });
    const locked = barrier();
    const releaseLock = barrier();
    const bothRequested = barrier();
    const winnerEntered = barrier();
    const releaseWinner = barrier();
    const loserRejected = barrier();
    let claimRequests = 0;
    const extended = prisma.$extends({
      query: {
        gameExecution: {
          updateMany({ args, query }) {
            const pending = query(args).then((result) => result);
            if (args.where?.gameId === fixture.gameId && args.data.generation) {
              claimRequests += 1;
              if (claimRequests === 2) bothRequested.release();
            }
            return pending;
          },
        },
      },
    }) as unknown as PrismaService;
    const contenders = [new GameRecoveryService(extended), new GameRecoveryService(extended)];
    const entered: Array<{ index: number; owner: string }> = [];
    const rejected: Array<{ index: number; error: unknown }> = [];
    const blocker = prisma.$transaction(async (tx) => {
      await tx.gameExecution.updateMany({
        where: { gameId: fixture.gameId },
        data: { generation: { increment: 0 } },
      });
      locked.release();
      await releaseLock.promise;
    });
    await locked.promise;
    const running = contenders.map((contender, index) =>
      contender
        .run(execution, new AbortController().signal, async (claimedSignal) => {
          const owner = contender.current!.owner;
          entered.push({ index, owner });
          winnerEntered.release();
          await releaseWinner.promise;
          return new EventWriterService(extended, contender).writeVoteBatch({
            ...voteBatch(candidates, claimedSignal),
            execution: { gameId: fixture.gameId, generation: execution.generation, owner },
          });
        })
        .catch((error: unknown) => {
          rejected.push({ index, error });
          loserRejected.release();
          throw error;
        }),
    );
    const settled = Promise.allSettled(running);
    try {
      // 两方都已经发起领取 SQL；正确实现只允许一方在放锁后读到可领取状态。
      await bothRequested.promise;
      expect(entered).toHaveLength(0);
      expect(
        await prisma.gameExecution.findUniqueOrThrow({ where: { gameId: fixture.gameId } }),
      ).toMatchObject({
        owner: null,
        generation: execution.generation,
        deadline: execution.deadline,
      });
      releaseLock.release();
      await blocker;
      await Promise.all([winnerEntered.promise, loserRejected.promise]);
      expect(entered).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].index).not.toBe(entered[0].index);
      expect(rejected[0].error).toBeInstanceOf(ExecutionOwnershipError);
      expect(
        await prisma.gameExecution.findUniqueOrThrow({ where: { gameId: fixture.gameId } }),
      ).toMatchObject({
        owner: entered[0].owner,
        generation: execution.generation,
        deadline: execution.deadline,
        dispatchPending: false,
      });
      for (const value of Object.values(await facts())) expect(value).toHaveLength(0);
    } finally {
      releaseLock.release();
      releaseWinner.release();
      await blocker;
    }
    const results = await settled;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results[entered[0].index]).toMatchObject({
      status: 'fulfilled',
      value: expect.arrayContaining([expect.objectContaining({ replayed: false })]),
    });
    const saved = await facts();
    expect(saved.events).toHaveLength(6);
    expect(saved.contexts).toHaveLength(6);
    expect(saved.memory).toHaveLength(6);
    expect(saved.knowledge).toHaveLength(6);
    expect(saved.batches).toHaveLength(1);
    expect(saved.outbox).toHaveLength(1);
    expect(saved.batches[0].eventIds).toEqual(saved.events.map(({ id }) => id));
    expect(saved.outbox[0].eventIds).toEqual(saved.batches[0].eventIds);
    expect(saved.steps).toHaveLength(0);
    expect(saved.checkpoints).toHaveLength(0);
    expect(saved.writes).toHaveLength(0);
    expect(fixture.game.model.requests).toHaveLength(requested);
    for (const candidate of candidates)
      expect(
        saved.events.find(({ actorId }) => actorId === candidate.reference.playerId)?.source,
      ).toEqual(candidate.source);
    expect(
      await prisma.gameExecution.findUniqueOrThrow({ where: { gameId: fixture.gameId } }),
    ).toMatchObject({
      owner: null,
      generation: execution.generation,
      deadline: execution.deadline,
      dispatchPending: false,
    });
  });

  it('已被领取时拒绝另一方进入，完成后也拒绝同代再次执行', async () => {
    const execution = await prepare();
    const entered = barrier();
    const release = barrier();
    fixture.game.model.beforeRequest = async (request) => {
      if (request.seat === 1 && request.kind === 'stream') {
        entered.release();
        await release.promise;
      }
    };
    const running = runtime.runVoteRound(round(execution));
    await entered.promise;
    await expect(runtime.runVoteRound(round(execution))).rejects.toBeInstanceOf(
      ExecutionOwnershipError,
    );
    await expect(
      recovery.run(execution, new AbortController().signal, async () => {}),
    ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    release.release();
    const events = await running;
    expect(events).toHaveLength(6);
    const saved = await facts();
    expect(saved.events).toHaveLength(6);
    expect(saved.batches).toHaveLength(1);
    expect(saved.contexts).toHaveLength(6);
    expect(saved.memory).toHaveLength(6);
    expect(saved.knowledge).toHaveLength(6);
    expect(saved.steps.every((step) => step.key.startsWith('model-stage/'))).toBe(true);
    await expect(runtime.runVoteRound(round(execution))).rejects.toBeInstanceOf(
      ExecutionOwnershipError,
    );
    expect(await facts()).toEqual(saved);
  });

  it('旧模型请求在途换代后，新代采用原输入和来源，旧响应不能污染任何事实', async () => {
    const execution = await prepare();
    const entered = barrier();
    const release = barrier();
    let holding = true;
    let started = 0;
    let oldFinished = false;
    const requestInputs: Array<{ seat: number; kind: string; messages: string }> = [];
    fixture.game.model.beforeRequest = async (request) => {
      requestInputs.push({
        seat: request.seat,
        kind: request.kind,
        messages: JSON.stringify(request.messages),
      });
      if (!holding) return;
      if (++started === 6) entered.release();
      await release.promise;
    };
    const oldRun = runtime
      .runVoteRound(round(execution))
      .then(
        () => {
          throw new Error('旧执行不应成功');
        },
        (error: unknown) => error,
      )
      .finally(() => {
        oldFinished = true;
      });
    await entered.promise;
    const oldInputs = requestInputs.slice();
    const frozen = (await facts()).checkpoints
      .map(
        (row) =>
          (row.checkpoint as unknown as { channel_values: { prepared?: PreparedTurnInput[] } })
            .channel_values.prepared,
      )
      .find((prepared) => prepared?.length === 6)!;
    expect(frozen).toHaveLength(6);
    await recovery.interrupt(fixture.gameId, execution.generation);
    const successor = await recovery.prepareResume(fixture.gameId);
    expect(successor.deadline).toEqual(execution.deadline);
    holding = false;
    await runtime.resumeVoteRound({
      execution: successor,
      phaseInstanceId: 'node/0/vote',
      signal: new AbortController().signal,
    });
    const adopted = await facts();
    const finishedBeforeRelease = oldFinished;
    release.release();
    expect(await oldRun).toBeDefined();
    expect(finishedBeforeRelease).toBe(false);
    expect(adopted.events).toHaveLength(6);
    expect(adopted.contexts).toHaveLength(6);
    expect(adopted.memory).toHaveLength(6);
    expect(adopted.knowledge).toHaveLength(6);
    expect(adopted.batches).toHaveLength(1);
    expect(adopted.outbox).toHaveLength(1);
    for (const input of frozen) {
      const event = adopted.events.find((value) => value.actorId === input.player.id)!;
      expect(event.source).toMatchObject(input.source);
      expect(adopted.contexts.find((value) => value.eventId === event.id)?.snapshot).toMatchObject(
        input.replay,
      );
      expect(
        adopted.memory.filter((value) => value.eventId === event.id).map((value) => value.memoryId),
      ).toEqual(input.pendingMemoryUsages.map((value) => value.memoryId));
      expect(
        adopted.knowledge
          .filter((value) => value.eventId === event.id)
          .map((value) => value.chunkId),
      ).toEqual(input.pendingKnowledgeUsages.map((value) => value.chunkId));
    }
    for (const original of oldInputs) {
      const resumed = requestInputs
        .slice(6)
        .find((request) => request.seat === original.seat && request.kind === 'stream');
      expect(resumed?.messages).toBe(original.messages);
    }
    expect(await facts()).toEqual(adopted);
    const thinking = adopted.steps.filter((step) => step.key.endsWith('/thinking/0'));
    expect(thinking).toHaveLength(6);
    for (const step of thinking) {
      const state = decodeRecoveryValue<ModelStageState>(step.output);
      expect(state.attempts).toBe(2);
      expect(state.deadline).toBeLessThanOrEqual(execution.deadline!.getTime());
    }
  });

  it.each(['put', 'putWrites'] as const)(
    '%s 在途换代后拒绝晚写，新代再次失锁仍保留原进度',
    async (method) => {
      const execution = await prepare();
      const blocked = barrier();
      const release = barrier();
      let savedConfig: Awaited<ReturnType<PrismaCheckpointSaver['put']>>;
      const oldRun = recovery
        .run(execution, new AbortController().signal, async (signal) => {
          const saver = new PrismaCheckpointSaver(prisma, identity(), 'node/0/vote', signal);
          const checkpoint = emptyCheckpoint();
          checkpoint.channel_values = { frozen: '原输入' };
          savedConfig = await saver.put(
            { configurable: { thread_id: fixture.gameId } },
            checkpoint,
            metadata,
            {},
          );
          await saver.putWrites(
            savedConfig,
            [['__return__', { playerId: fixture.players[0].id, candidate: '原候选' }]],
            'original',
          );
          const encode = saver.serde.dumpsTyped.bind(saver.serde);
          jest.spyOn(saver.serde, 'dumpsTyped').mockImplementation(async (value) => {
            if (JSON.stringify(value).includes('旧代晚写')) {
              blocked.release();
              await release.promise;
            }
            return encode(value);
          });
          if (method === 'put') {
            const late = emptyCheckpoint();
            late.channel_values = { late: '旧代晚写' };
            await saver.put(savedConfig, late, metadata, {});
          } else {
            await saver.putWrites(savedConfig, [['__return__', '旧代晚写']], 'late');
          }
        })
        .then(
          () => {
            throw new Error('旧检查点不应写入');
          },
          (error: unknown) => error,
        );
      await blocked.promise;
      await recovery.interrupt(fixture.gameId, execution.generation);
      const successor = await recovery.prepareResume(fixture.gameId);
      let firstRead: Awaited<ReturnType<PrismaCheckpointSaver['getTuple']>>;
      const interrupted = new Error('接管后再次失锁');
      await expect(
        recovery.run(successor, new AbortController().signal, async (signal) => {
          const saver = new PrismaCheckpointSaver(prisma, identity(), 'node/0/vote', signal);
          firstRead = await saver.getTuple(savedConfig!);
          expect(firstRead?.checkpoint.channel_values).toEqual({ frozen: '原输入' });
          expect(firstRead?.pendingWrites).toEqual([
            ['original', '__return__', { playerId: fixture.players[0].id, candidate: '原候选' }],
          ]);
          throw interrupted;
        }),
      ).rejects.toBe(interrupted);
      await recovery.interrupt(fixture.gameId, successor.generation);
      const third = await recovery.prepareResume(fixture.gameId);
      await recovery.run(third, new AbortController().signal, async (signal) => {
        const saver = new PrismaCheckpointSaver(prisma, identity(), 'node/0/vote', signal);
        expect(await saver.getTuple(savedConfig!)).toEqual(firstRead!);
        release.release();
        expect(await oldRun).toBeInstanceOf(ExecutionOwnershipError);
        expect(await saver.getTuple(savedConfig!)).toEqual(firstRead!);
      });
      const saved = await facts();
      expect(saved.checkpoints).toHaveLength(1);
      expect(saved.writes).toHaveLength(1);
      expect(saved.events).toHaveLength(0);
      expect(saved.batches).toHaveLength(0);
      expect(saved.contexts).toHaveLength(0);
      expect(saved.memory).toHaveLength(0);
      expect(saved.knowledge).toHaveLength(0);
      expect(saved.outbox).toHaveLength(0);
      expect(third.deadline).toEqual(execution.deadline);
    },
  );

  it('运行中原期限取消请求，到期后新阶段和检查点均不得写入', async () => {
    const execution = await prepare(2_000);
    const requestEntered = barrier();
    fixture.game.model.beforeRequest = async (request) => {
      requestEntered.release();
      if (!request.signal.aborted)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    };
    const failed = runtime.runVoteRound(round(execution)).then(
      () => {
        throw new Error('超期执行不应成功');
      },
      (error: unknown) => error,
    );
    await requestEntered.promise;
    expect(await failed).toBeDefined();
    expect(Date.now()).toBeGreaterThanOrEqual(execution.deadline!.getTime());
    const saved = await facts();
    const requests = fixture.game.model.requests.length;
    expect(requests).toBeGreaterThan(0);
    expect(saved.events).toHaveLength(0);
    expect(saved.batches).toHaveLength(0);
    expect(saved.contexts).toHaveLength(0);
    expect(saved.memory).toHaveLength(0);
    expect(saved.knowledge).toHaveLength(0);
    expect(saved.outbox).toHaveLength(0);
    await expect(runtime.runVoteRound(round(execution, 'node/1/vote'))).rejects.toThrow();
    await recovery.interrupt(fixture.gameId, execution.generation);
    await expect(recovery.prepareResume(fixture.gameId)).rejects.toThrow('原定运行期限已到');
    expect(fixture.game.model.requests).toHaveLength(requests);
    expect(await facts()).toEqual(saved);
  });

  it('取得执行锁后取消，模型阶段更新整个事务回滚', async () => {
    const execution = await prepare();
    const cancelled = new Error('执行已取消');
    await recovery.run(execution, new AbortController().signal, async () => {
      const controller = new AbortController();
      const store = createStageRecordStore({
        prisma,
        identity: identity(),
        prefix: 'model-stage/cancelled',
        signal: controller.signal,
      });
      await expect(
        store.update('final', () => {
          controller.abort(cancelled);
          return {
            version: 1,
            inputHash: '冻结输入',
            deadline: execution.deadline!.getTime(),
            attempts: 1,
          };
        }),
      ).rejects.toBe(cancelled);
    });
    expect((await facts()).steps).toHaveLength(0);
  });

  it('原期限到期后仍持有 owner 也不能初始化新阶段或写检查点', async () => {
    const execution = await prepare(500);
    await recovery.run(execution, new AbortController().signal, async (signal) => {
      const owner = identity();
      const saver = new PrismaCheckpointSaver(prisma, owner, 'node/0/vote');
      const config = await saver.put(
        { configurable: { thread_id: fixture.gameId } },
        emptyCheckpoint(),
        metadata,
        {},
      );
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      // 故意不传取消信号，确认数据库执行期限也独立挡住迟到的调用。
      const store = createStageRecordStore({ prisma, identity: owner, prefix: 'model-stage/new' });
      await expect(
        store.update('final', () => ({
          version: 1,
          inputHash: '输入',
          deadline: Date.now() + 30_000,
          attempts: 0,
        })),
      ).rejects.toThrow('对局原定运行期限已到');
      await expect(saver.put(config, emptyCheckpoint(), metadata, {})).rejects.toThrow(
        '对局原定运行期限已到',
      );
      await expect(saver.putWrites(config, [['__return__', '迟到候选']], 'late')).rejects.toThrow(
        '对局原定运行期限已到',
      );
    });
    const saved = await facts();
    expect(saved.steps).toHaveLength(0);
    expect(saved.checkpoints).toHaveLength(1);
    expect(saved.writes).toHaveLength(0);
  });

  it('检查点等待执行行锁期间到期，取得锁后仍拒绝落库', async () => {
    const execution = await prepare(500);
    await recovery.run(execution, new AbortController().signal, async (signal) => {
      const locked = barrier();
      const release = barrier();
      const blocker = prisma.$transaction(async (tx) => {
        await tx.gameExecution.updateMany({
          where: { gameId: fixture.gameId },
          data: { generation: { increment: 0 } },
        });
        locked.release();
        await release.promise;
      });
      await locked.promise;
      const saver = new PrismaCheckpointSaver(prisma, identity(), 'node/0/vote');
      const late = saver.put(
        { configurable: { thread_id: fixture.gameId } },
        emptyCheckpoint(),
        metadata,
        {},
      );
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      release.release();
      await blocker;
      await expect(late).rejects.toThrow('对局原定运行期限已到');
    });
    expect((await facts()).checkpoints).toHaveLength(0);
  });

  it('Worker 遇到等待执行行锁期间到期会中止对局，不冒充已失权而留下 running', async () => {
    const execution = await prepare(2_000);
    const fenceEntered = barrier();
    let fenceStartedAt = 0;
    const extended = prisma.$extends({
      query: {
        gameExecution: {
          updateManyAndReturn({ args, query }) {
            fenceStartedAt = Date.now();
            fenceEntered.release();
            return query(args);
          },
        },
      },
    }) as unknown as PrismaService;
    fixture.game.execution.mockImplementation(async (gameId, generation) => {
      expect({ gameId, generation }).toEqual({
        gameId: fixture.gameId,
        generation: execution.generation,
      });
      return recovery.run(execution, new AbortController().signal, async (signal) => {
        const locked = barrier();
        const release = barrier();
        const blocker = prisma.$transaction(async (tx) => {
          await tx.gameExecution.updateMany({
            where: { gameId: fixture.gameId },
            data: { generation: { increment: 0 } },
          });
          locked.release();
          await release.promise;
        });
        await locked.promise;
        const store = createStageRecordStore({
          prisma: extended,
          identity: identity(),
          prefix: 'model-stage/worker-deadline',
          signal,
        });
        const writing = store.update('final', () => ({
          version: 1,
          inputHash: '等待执行行锁的输入',
          deadline: execution.deadline!.getTime(),
          attempts: 0,
        }));
        void writing.catch(() => {});
        try {
          await fenceEntered.promise;
          expect(fenceStartedAt).toBeLessThan(execution.deadline!.getTime());
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
        } finally {
          release.release();
          await blocker;
        }
        await writing;
        throw new Error('原期限到期后不应完成模型阶段写入');
      });
    });
    const failure = await fixture.game.worker
      .process({
        ...fixture.game.job,
        data: { gameId: fixture.gameId, generation: execution.generation },
      } as typeof fixture.game.job)
      .then(
        () => {
          throw new Error('原期限到期后 Worker 不应成功');
        },
        (error: unknown) => error,
      );
    expect(await prisma.game.findUniqueOrThrow({ where: { id: fixture.gameId } })).toMatchObject({
      status: 'aborted',
      endedAt: expect.any(Date),
    });
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toBe('对局原定运行期限已到');
    expect(fixture.game.execution).toHaveBeenCalledTimes(1);
    expect(fixture.game.model.requests).toHaveLength(0);
    for (const value of Object.values(await facts())) expect(value).toHaveLength(0);
    expect(
      await prisma.gameExecution.findUniqueOrThrow({ where: { gameId: fixture.gameId } }),
    ).toMatchObject({
      generation: execution.generation,
      deadline: execution.deadline,
      owner: null,
      dispatchPending: false,
    });
  });

  it('实际心跳刷新存活时间，并在失去领取权后取消运行范围', async () => {
    const execution = await prepare();
    const refreshed = barrier();
    const update = prisma.gameExecution.updateMany.bind(prisma.gameExecution);
    jest.spyOn(prisma.gameExecution, 'updateMany').mockImplementation((async (args) => {
      const result = await update(args);
      if (args.where?.owner && args.data.heartbeatAt && result.count) refreshed.release();
      return result;
    }) as typeof prisma.gameExecution.updateMany);
    const active = recovery.run(execution, new AbortController().signal, async (signal) => {
      const claimed = await prisma.gameExecution.findUniqueOrThrow({
        where: { gameId: fixture.gameId },
      });
      await refreshed.promise;
      const alive = await prisma.gameExecution.findUniqueOrThrow({
        where: { gameId: fixture.gameId },
      });
      expect(alive.heartbeatAt!.getTime()).toBeGreaterThan(claimed.heartbeatAt!.getTime());
      await recovery.interrupt(fixture.gameId, execution.generation);
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      signal.throwIfAborted();
    });
    await expect(active).rejects.toBeInstanceOf(ExecutionOwnershipError);
    expect((await facts()).events).toHaveLength(0);
  });
});
