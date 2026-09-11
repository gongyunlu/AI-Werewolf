import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { ModelCallError } from '../src/llm/model-call-guard';
import {
  ExecutionOwnershipError,
  GameRecoveryService,
  type RecoveryManifest,
} from '../src/game-recovery/game-recovery.service';
import { decodeRecoveryValue, encodeRecoveryValue } from '../src/game-recovery/recovery-value';
import type { GameExecution, Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import type { RedisService } from '../src/redis/redis.service';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('game recovery: isolated PostgreSQL execution journal', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let module: TestingModule;
  let prisma: PrismaService;
  let recovery: GameRecoveryService;
  let schema: string;
  let rulesetId: string;
  let gameId: string;
  let execution: GameExecution;
  const manifest: RecoveryManifest = {
    version: 1,
    fingerprint: 'test-code-and-models-v1',
    prompts: { turn: { text: 'frozen prompt', version: 7 } },
  };
  const initialState = {
    day: 2,
    players: new Map([['player-a', { alive: true }]]),
    startedAt: new Date('2026-09-10T01:02:03.456Z'),
  };

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
    const [row] = await prisma.$queryRaw<
      Array<{ schema: string }>
    >`SELECT current_schema()::text AS schema`;
    schema = row.schema;
    // 全部正式迁移由辅助代码应用到独立数据库，故障注入也只访问该连接。
    module = await Test.createTestingModule({
      providers: [GameRecoveryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    recovery = module.get(GameRecoveryService);
    rulesetId = randomUUID();
    await prisma.ruleset.create({
      data: { id: rulesetId, name: 'Recovery tests', playerCount: 1, definition: {} },
    });
  });

  afterAll(async () => {
    await module?.close();
    await database?.close();
  });

  beforeEach(async () => {
    // Each example owns a game; every query below is scoped to that game.
    const game = await prisma.game.create({
      data: { rulesetId, skillVersion: 'test', status: GAME_STATUSES.RUNNING },
    });
    gameId = game.id;
    execution = await recovery.create(
      gameId,
      initialState,
      manifest,
      new Date(Date.now() + 600_000),
    );
  });

  const run = <T>(callback: () => Promise<T>) =>
    recovery.run(execution, new AbortController().signal, callback);
  const steps = () => prisma.gameExecutionStep.findMany({ where: { gameId } });
  const events = () => prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } });

  async function settlementPlayers() {
    const agent = await prisma.agent.create({
      data: {
        name: randomUUID(),
        defaultModelName: 'mock',
        memoryLabel: 'test',
      },
    });
    return prisma.player.create({
      data: {
        gameId,
        agentId: agent.id,
        seatNo: 1,
        displayName: '结算测试',
        modelName: 'mock',
        memoryLabelSnapshot: 'test',
      },
    });
  }

  function settlementWriter(recoverable: boolean) {
    let sequence = 0;
    const redis = {
      incr: async () => ++sequence,
      set: async (_key: string, value: number) => {
        sequence = value;
      },
    };
    return new EventWriterService(
      prisma,
      redis as unknown as RedisService,
      recoverable ? recovery : undefined,
    );
  }

  it.each([false, true])(
    '夜间结算第二项写入失败时，首项死亡、事件及效果记录整体回滚（恢复=%s）',
    async (recoverable) => {
      const player = await settlementPlayers();
      const writer = settlementWriter(recoverable);
      const commit = () =>
        writer.commitNightResolution({
          gameId,
          day: 2,
          deaths: [
            { playerId: player.id, seatNo: 1, cause: 'night_kill' },
            { playerId: randomUUID(), seatNo: 2, cause: 'witch_poison' },
          ],
        });
      await expect(recoverable ? run(commit) : commit()).rejects.toMatchObject({ code: 'P2025' });
      expect(
        (await prisma.player.findUniqueOrThrow({ where: { id: player.id } })).deathDay,
      ).toBeNull();
      expect(await events()).toHaveLength(0);
      expect(await steps()).toHaveLength(0);
    },
  );

  it.each([false, true])(
    '放逐状态写入失败时不能单独留下放逐事件（恢复=%s）',
    async (recoverable) => {
      const writer = settlementWriter(recoverable);
      const commit = () =>
        writer.commitExile({
          gameId,
          day: 2,
          targetId: randomUUID(),
          targetSeatNo: 1,
          voteCount: 3,
        });
      await expect(recoverable ? run(commit) : commit()).rejects.toMatchObject({ code: 'P2025' });
      expect(await events()).toHaveLength(0);
      expect(await steps()).toHaveLength(0);
    },
  );

  it.each(['night', 'exile'] as const)(
    '结算提交后响应丢失，恢复复用原事件与状态（%s）',
    async (kind) => {
      const player = await settlementPlayers();
      const writer = settlementWriter(true);
      const commit = () =>
        kind === 'night'
          ? writer.commitNightResolution({
              gameId,
              day: 2,
              deaths: [{ playerId: player.id, seatNo: 1, cause: 'night_kill' }],
            })
          : writer.commitExile({
              gameId,
              day: 2,
              targetId: player.id,
              targetSeatNo: 1,
              voteCount: 3,
            });
      await expect(
        run(async () => {
          await commit();
          throw new Error('结算响应丢失');
        }),
      ).rejects.toThrow('结算响应丢失');
      const [original] = await events();
      await expect(run(commit)).resolves.toEqual(original);
      expect(await events()).toHaveLength(1);
      expect(await steps()).toHaveLength(1);
      expect(await prisma.player.findUniqueOrThrow({ where: { id: player.id } })).toMatchObject({
        deathDay: 2,
        deathCause: kind === 'night' ? 'night_kill' : 'execution',
      });
    },
  );

  it('旧执行代次不能写入夜间结算或死亡状态', async () => {
    const player = await settlementPlayers();
    const writer = settlementWriter(true);
    await run(async () => {
      await recovery.interrupt(gameId, execution.generation);
      await expect(
        writer.commitNightResolution({
          gameId,
          day: 2,
          deaths: [{ playerId: player.id, seatNo: 1, cause: 'night_kill' }],
        }),
      ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    });
    expect(await events()).toHaveLength(0);
    expect(
      (await prisma.player.findUniqueOrThrow({ where: { id: player.id } })).deathDay,
    ).toBeNull();
  });

  it('缓存查询等待期间取消后，不返回已保存的模型结果', async () => {
    await run(() => recovery.value('cached-speech', async () => '已缓存的发言'));
    const controller = new AbortController();
    const read = prisma.gameExecutionStep.findUnique.bind(prisma.gameExecutionStep);
    const query = jest.spyOn(prisma.gameExecutionStep, 'findUnique').mockImplementationOnce((async (
      args: Parameters<typeof read>[0],
    ) => {
      const row = await read(args);
      controller.abort(new Error('测试取消'));
      return row;
    }) as never);
    try {
      const generate = jest.fn(async () => '不得重新生成');
      await expect(
        recovery.run(execution, controller.signal, () => recovery.value('cached-speech', generate)),
      ).rejects.toThrow('测试取消');
      expect(generate).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it.each([undefined, 1])(
    '无检查点任务失锁时明确中止，不留下虚假的运行或恢复状态（generation=%s）',
    async (generation) => {
      await prisma.gameExecution.delete({ where: { gameId } });
      await expect(recovery.interrupt(gameId, generation)).resolves.toBe(true);
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game.status).toBe(GAME_STATUSES.ABORTED);
      expect(game.endedAt).not.toBeNull();
    },
  );

  const event = (tx: Prisma.TransactionClient, sequence = 1) =>
    tx.event.create({
      data: {
        gameId,
        sequence,
        day: 2,
        phase: 'vote',
        actionType: 'vote',
        content: { target: 'player-a' },
      },
    });

  async function waitForBlockedTransaction(blockerPid: number) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${blockerPid}::integer = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `;
      if (row.blocked) return;
      await new Promise((accept) => setTimeout(accept, 10));
    }
    throw new Error('Concurrent transaction did not reach the expected row lock');
  }

  it('keeps the original state, prompts and deadline when creation is retried', async () => {
    const retry = await recovery.create(
      gameId,
      { day: 99 },
      { ...manifest, fingerprint: 'changed' },
      new Date(Date.now() + 900_000),
    );
    expect(decodeRecoveryValue(retry.initialState)).toEqual(initialState);
    expect(decodeRecoveryValue(retry.manifest)).toEqual(manifest);
    expect(retry.deadline).toEqual(execution.deadline);
  });

  it('reuses frozen node state and saved model input/output after an unfinished node restarts', async () => {
    const input = jest.fn().mockResolvedValue({ prompt: 'original prompt', history: ['event-1'] });
    const model = jest
      .fn()
      .mockResolvedValue({ type: 'map', value: 'ordinary model JSON', target: 'player-a' });
    const first = async (state: typeof initialState) => {
      expect(state.players).toBeInstanceOf(Map);
      const request = await recovery.value('model-input', input);
      await recovery.value('model-output', () => model(request));
      throw new Error('worker disconnected before node completion');
    };
    await expect(run(() => recovery.node(0, 'vote', initialState, first))).rejects.toThrow(
      'worker disconnected',
    );

    const restoredState = jest.fn();
    const restarted = new GameRecoveryService(prisma);
    const result = await restarted.run(execution, new AbortController().signal, () =>
      restarted.node(0, 'vote', { ...initialState, day: 99, players: new Map() }, async (state) => {
        restoredState(state);
        const request = await restarted.value('model-input', input);
        return restarted.value('model-output', () => model(request));
      }),
    );
    expect(restoredState).toHaveBeenCalledWith(initialState);
    expect(input).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledWith({ prompt: 'original prompt', history: ['event-1'] });
    expect(result).toEqual({ type: 'map', value: 'ordinary model JSON', target: 'player-a' });
    expect((await steps()).every((step) => step.completed)).toBe(true);
    expect(recovery.current).toBeUndefined();
    expect(restarted.current).toBeUndefined();
  });

  it('returns a completed node without re-running its callback or losing Map and Date output', async () => {
    const output = { votes: new Map([['a', 'b']]), at: new Date('2026-09-10T02:00:00Z') };
    await run(() => recovery.node(0, 'vote', initialState, async () => output));
    const callback = jest.fn().mockRejectedValue(new Error('completed nodes must not execute'));
    const restored = await run(() => recovery.node(0, 'vote', initialState, callback));
    expect(callback).not.toHaveBeenCalled();
    expect(restored).toEqual(output);
  });

  it('keeps nested calls in concurrently executing branches independent on replay', async () => {
    const bothStarted = deferred();
    let started = 0;
    const model = jest.fn(async (player: string) => {
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      return { player, choice: `${player}-target` };
    });
    const calls = () =>
      Promise.all(
        ['a', 'b'].map((player) =>
          recovery.value('player', () => recovery.value('model', () => model(player))),
        ),
      );
    await expect(
      run(() =>
        recovery.node(0, 'vote', initialState, async () => {
          await calls();
          throw new Error('after parallel model calls');
        }),
      ),
    ).rejects.toThrow('after parallel model calls');

    const output = await run(() => recovery.node(0, 'vote', initialState, calls));
    expect(output).toEqual([
      { player: 'a', choice: 'a-target' },
      { player: 'b', choice: 'b-target' },
    ]);
    expect(model).toHaveBeenCalledTimes(2);
    const saved = await steps();
    expect(saved).toHaveLength(5);
    expect(new Set(saved.map((step) => step.key)).size).toBe(5);
  });

  it('replays the same classified model failure and retry metadata', async () => {
    const failure = new ModelCallError('circuit_open', undefined, Date.now() + 20_000, {
      httpStatus: 429,
    });
    const model = jest.fn().mockRejectedValue(failure);
    await expect(run(() => recovery.value('model', model))).rejects.toMatchObject({
      code: failure.code,
      retryAt: failure.retryAt,
      details: failure.details,
    });
    const retry = run(() => recovery.value('model', model));
    await expect(retry).rejects.toBeInstanceOf(ModelCallError);
    await expect(retry).rejects.toMatchObject({
      code: failure.code,
      retryAt: failure.retryAt,
      details: failure.details,
    });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('does not cache programming errors as model outcomes', async () => {
    const model = jest.fn().mockRejectedValueOnce(new Error('bug')).mockResolvedValueOnce('fixed');
    await expect(run(() => recovery.value('model', model))).rejects.toThrow('bug');
    expect(await steps()).toHaveLength(0);
    await expect(run(() => recovery.value('model', model))).resolves.toBe('fixed');
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('does not store an output returned after the execution signal was cancelled', async () => {
    const controller = new AbortController();
    const cancellation = new Error('execution cancelled');
    await expect(
      recovery.run(execution, controller.signal, () =>
        recovery.value('model', async () => {
          controller.abort(cancellation);
          return 'late output';
        }),
      ),
    ).rejects.toBe(cancellation);
    expect(await steps()).toHaveLength(0);
  });

  it('rolls back an in-flight effect if execution is cancelled before commit', async () => {
    const controller = new AbortController();
    const cancellation = new Error('execution cancelled before commit');
    await expect(
      recovery.run(execution, controller.signal, () =>
        recovery.effect('vote', async (tx) => {
          const written = await event(tx);
          controller.abort(cancellation);
          return written;
        }),
      ),
    ).rejects.toBe(cancellation);
    expect(await events()).toHaveLength(0);
    expect(await steps()).toHaveLength(0);
  });

  it('keeps a cancelled node unfinished for the next executor', async () => {
    const controller = new AbortController();
    const cancellation = new Error('node cancelled before completion');
    await expect(
      recovery.run(execution, controller.signal, () =>
        recovery.node(0, 'vote', initialState, async () => {
          controller.abort(cancellation);
          return { voted: true };
        }),
      ),
    ).rejects.toBe(cancellation);
    const saved = await steps();
    expect(saved).toHaveLength(1);
    expect(saved[0].completed).toBe(false);
    expect(saved[0].output).toBeNull();
    expect(decodeRecoveryValue<{ state: typeof initialState }>(saved[0].input).state).toEqual(
      initialState,
    );
  });

  it('uses the original deadline to cancel in-flight effects without a separate caller timer', async () => {
    execution = await prisma.gameExecution.update({
      where: { gameId },
      data: { deadline: new Date(Date.now() + 1_000) },
    });
    await expect(
      recovery.run(execution, new AbortController().signal, (signal) =>
        recovery.effect('vote', async (tx) => {
          const value = await event(tx);
          if (!signal.aborted)
            await new Promise<void>((accept) =>
              signal.addEventListener('abort', () => accept(), { once: true }),
            );
          return value;
        }),
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await events()).toHaveLength(0);
    expect(await steps()).toHaveLength(0);
  });

  it('does not expose an effect or completion record before their transaction commits', async () => {
    const written = deferred();
    const commit = deferred();
    const pending = run(() =>
      recovery.effect('vote', async (tx) => {
        const value = await event(tx);
        written.resolve();
        await commit.promise;
        return value;
      }),
    );
    try {
      await written.promise;
      expect(await events()).toHaveLength(0);
      expect(await steps()).toHaveLength(0);
    } finally {
      commit.resolve();
      await pending;
    }
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('reuses the original committed event after a response is lost', async () => {
    const write = jest.fn((tx: Prisma.TransactionClient) => event(tx));
    await expect(
      run(async () => {
        await recovery.effect('vote', write);
        throw new Error('response lost');
      }),
    ).rejects.toThrow('response lost');
    const [committed] = await events();
    const restored = await run(() => recovery.effect('vote', write));
    expect(restored).toEqual(committed);
    expect(restored.createdAt).toBeInstanceOf(Date);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('rolls back the domain effect if writing its completion record fails', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schema}"."game_execution_steps" ADD CONSTRAINT recovery_reject_completion CHECK (NOT completed) NOT VALID`,
    );
    try {
      await expect(run(() => recovery.effect('vote', (tx) => event(tx)))).rejects.toThrow(
        'recovery_reject_completion',
      );
      expect(await events()).toHaveLength(0);
      expect(await steps()).toHaveLength(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."game_execution_steps" DROP CONSTRAINT recovery_reject_completion`,
      );
    }
    await run(() => recovery.effect('vote', (tx) => event(tx)));
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('rolls back partial effect writes when the callback fails', async () => {
    await expect(
      run(() =>
        recovery.effect('vote', async (tx) => {
          await event(tx);
          throw new Error('projection failed');
        }),
      ),
    ).rejects.toThrow('projection failed');
    expect(await events()).toHaveLength(0);
    expect(await steps()).toHaveLength(0);
  });

  it('rejects a duplicate worker while the current executor still owns the game', async () => {
    const callback = jest.fn().mockResolvedValue(undefined);
    await run(async () => {
      await expect(
        recovery.run(execution, new AbortController().signal, callback),
      ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    });
    expect(callback).not.toHaveBeenCalled();
    expect((await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).owner).toBeNull();
  });

  it('rejects an expired executor output and does not clear the successor ownership', async () => {
    const started = deferred();
    const finishOld = deferred();
    const old = run(() =>
      recovery.value('model', async () => {
        started.resolve();
        await finishOld.promise;
        return 'old output';
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    try {
      expect(await recovery.interrupt(gameId)).toBe(true);
      await recovery.prepareResume(gameId, manifest.fingerprint);
      const successor = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
      await recovery.run(successor, new AbortController().signal, async () => {
        const owner = recovery.current?.owner;
        finishOld.resolve();
        expect(await old).toBeInstanceOf(ExecutionOwnershipError);
        expect((await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).owner).toBe(
          owner,
        );
        expect(await steps()).toHaveLength(0);
        await recovery.effect('vote', (tx) => event(tx));
      });
      expect(await events()).toHaveLength(1);
    } finally {
      finishOld.resolve();
      await old;
    }
  });

  it('fences domain writes after interruption before invoking the effect callback', async () => {
    const write = jest.fn((tx: Prisma.TransactionClient) => event(tx));
    await run(async () => {
      await recovery.interrupt(gameId);
      await expect(recovery.effect('vote', write)).rejects.toBeInstanceOf(ExecutionOwnershipError);
    });
    expect(write).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
    expect(await steps()).toHaveLength(0);
  });

  it('ignores a delayed interruption from a previous generation after a successor starts', async () => {
    await recovery.interrupt(gameId, execution.generation);
    const successor = await recovery.prepareResume(gameId, manifest.fingerprint);
    await recovery.run(successor, new AbortController().signal, async () => {
      const owner = recovery.current?.owner;
      expect(await recovery.interrupt(gameId, execution.generation)).toBe(false);
      expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
        GAME_STATUSES.RUNNING,
      );
      expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toMatchObject({
        generation: successor.generation,
        owner,
      });
      await recovery.effect('vote', (tx) => event(tx));
    });
    expect(await events()).toHaveLength(1);
  });

  it('does not let an interruption scan replace a committed finished game', async () => {
    const endedAt = new Date();
    await run(() =>
      recovery.node(0, 'checkWin', initialState, async () => {
        return recovery.effect('finish', async (tx) => {
          await event(tx);
          return tx.game.update({
            where: { id: gameId },
            data: { status: GAME_STATUSES.FINISHED, endedAt, winnerFaction: 'villager' },
          });
        });
      }),
    );
    expect(await recovery.interrupt(gameId)).toBe(false);
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: GAME_STATUSES.FINISHED,
      endedAt,
      winnerFaction: 'villager',
    });
    expect((await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).generation).toBe(
      execution.generation,
    );
    expect((await steps()).every((step) => step.completed)).toBe(true);
  });

  it('keeps a terminal result when interruption waits on the terminal transaction', async () => {
    const written = deferred<number>();
    const commit = deferred();
    const finish = run(() =>
      recovery.effect('finish', async (tx) => {
        const [connection] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await event(tx);
        const finished = await tx.game.update({
          where: { id: gameId },
          data: { status: GAME_STATUSES.FINISHED, winnerFaction: 'villager', endedAt: new Date() },
        });
        written.resolve(connection.pid);
        await commit.promise;
        return finished;
      }),
    );
    let interruption: Promise<boolean> | undefined;
    try {
      const pid = await written.promise;
      interruption = recovery.interrupt(gameId);
      await waitForBlockedTransaction(pid);
      expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
        GAME_STATUSES.RUNNING,
      );
    } finally {
      commit.resolve();
      await finish;
    }
    expect(await interruption).toBe(false);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.FINISHED,
    );
    expect((await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).generation).toBe(
      execution.generation,
    );
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('settles a terminal write racing interruption without a database deadlock', async () => {
    const fenced = deferred<number>();
    const finishWrite = deferred();
    const finish = run(() =>
      recovery.effect('finish', async (tx) => {
        const [connection] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        fenced.resolve(connection.pid);
        await finishWrite.promise;
        return tx.game.update({
          where: { id: gameId },
          data: { status: GAME_STATUSES.FINISHED, endedAt: new Date() },
        });
      }),
    );
    const pid = await fenced.promise;
    const interruption = recovery.interrupt(gameId);
    const outcomes = Promise.allSettled([finish, interruption]);
    try {
      await waitForBlockedTransaction(pid);
    } finally {
      finishWrite.resolve();
    }
    const [finished, interrupted] = await outcomes;
    if (interrupted.status === 'rejected') throw interrupted.reason;
    if (finished.status === 'rejected')
      expect(finished.reason).toBeInstanceOf(ExecutionOwnershipError);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    if (interrupted.status === 'fulfilled' && interrupted.value) {
      expect(game.status).toBe(GAME_STATUSES.PENDING_RECOVERY);
      expect(await steps()).toHaveLength(0);
    } else {
      expect(game.status).toBe(GAME_STATUSES.FINISHED);
      expect(await steps()).toHaveLength(1);
    }
  });

  it('keeps the original vote visibility boundary after partial events are committed', async () => {
    await event(prisma);
    await expect(
      run(() =>
        recovery.node(0, 'vote', initialState, async () => {
          expect(recovery.current?.visibleThrough).toBe(1);
          await recovery.effect('vote', (tx) => event(tx, 2));
          throw new Error('partial voting round');
        }),
      ),
    ).rejects.toThrow('partial voting round');
    await run(() =>
      recovery.node(0, 'vote', initialState, async () => {
        expect(recovery.current?.visibleThrough).toBe(1);
        await recovery.effect('vote', (tx) => event(tx, 2));
      }),
    );
    await run(() =>
      recovery.node(1, 'speech', initialState, async () => {
        expect(recovery.current?.visibleThrough).toBeUndefined();
      }),
    );
    expect(await events()).toHaveLength(2);
  });

  it('returns an execution that can immediately run after resume', async () => {
    await recovery.interrupt(gameId);
    const resumed = await recovery.prepareResume(gameId, manifest.fingerprint);
    await expect(
      recovery.run(resumed, new AbortController().signal, async () => 'resumed'),
    ).resolves.toBe('resumed');
    expect(resumed.deadline).toEqual(execution.deadline);
  });

  it('reuses one dispatch generation for concurrent resume requests before a worker claims it', async () => {
    await recovery.interrupt(gameId);
    const outcomes = await Promise.all([
      recovery.prepareResume(gameId, manifest.fingerprint),
      recovery.prepareResume(gameId, manifest.fingerprint),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({
      generation: execution.generation + 2,
      dispatchPending: true,
      deadline: execution.deadline,
      owner: null,
    });
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(
      outcomes[0],
    );
  });

  it('reuses the committed dispatch after the resume response is lost and the API restarts', async () => {
    const originalEvent = await run(() => recovery.effect('vote', (tx) => event(tx)));
    await recovery.interrupt(gameId);
    await expect(
      (async () => {
        await recovery.prepareResume(gameId, manifest.fingerprint);
        throw new Error('resume response lost before queue dispatch');
      })(),
    ).rejects.toThrow('resume response lost');
    const committed = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    expect(committed.dispatchPending).toBe(true);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.RUNNING,
    );

    const restarted = new GameRecoveryService(prisma);
    const retried = await restarted.prepareResume(gameId, manifest.fingerprint);
    expect(retried).toEqual(committed);
    expect(retried.deadline).toEqual(execution.deadline);
    const duplicateWrite = jest.fn().mockRejectedValue(new Error('must reuse the original vote'));
    await expect(
      restarted.run(retried, new AbortController().signal, () =>
        restarted.effect('vote', duplicateWrite),
      ),
    ).resolves.toEqual(originalEvent);
    expect(duplicateWrite).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('fences a dispatch interrupted before delivery and creates only one replacement generation', async () => {
    await recovery.interrupt(gameId);
    const firstDispatch = await recovery.prepareResume(gameId, manifest.fingerprint);
    expect(await recovery.interrupt(gameId, firstDispatch.generation)).toBe(true);
    const afterInterruption = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    const staleWorker = jest.fn().mockResolvedValue(undefined);
    await expect(
      recovery.run(firstDispatch, new AbortController().signal, staleWorker),
    ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    expect(staleWorker).not.toHaveBeenCalled();

    const replacement = await recovery.prepareResume(gameId, manifest.fingerprint);
    const replacementRetry = await recovery.prepareResume(gameId, manifest.fingerprint);
    expect(replacement.generation).toBe(afterInterruption.generation + 1);
    expect(replacementRetry).toEqual(replacement);
    expect(replacement.deadline).toEqual(execution.deadline);
    await expect(
      recovery.run(replacementRetry, new AbortController().signal, async () => 'replacement'),
    ).resolves.toBe('replacement');
  });

  it('clears pending dispatch on claim and refuses resume both during and after that claim', async () => {
    await recovery.interrupt(gameId);
    const prepared = await recovery.prepareResume(gameId, manifest.fingerprint);
    expect(prepared.dispatchPending).toBe(true);
    await recovery.run(prepared, new AbortController().signal, async () => {
      const claimed = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
      expect(claimed.dispatchPending).toBe(false);
      expect(claimed.owner).toBe(recovery.current?.owner);
      await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(claimed);
    });
    const released = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    expect(released).toMatchObject({
      owner: null,
      dispatchPending: false,
      generation: prepared.generation,
    });
    await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(released);
  });

  it('rolls back the running status when persisting pending dispatch fails', async () => {
    await recovery.interrupt(gameId);
    const before = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schema}"."game_executions" ADD CONSTRAINT recovery_reject_dispatch CHECK (NOT dispatch_pending) NOT VALID`,
    );
    try {
      await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toThrow(
        'recovery_reject_dispatch',
      );
      expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
        GAME_STATUSES.PENDING_RECOVERY,
      );
      expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."game_executions" DROP CONSTRAINT recovery_reject_dispatch`,
      );
    }
    const retry = await recovery.prepareResume(gameId, manifest.fingerprint);
    expect(retry).toMatchObject({ generation: before.generation + 1, dispatchPending: true });
  });

  it('still validates the fingerprint and original deadline when retrying an unclaimed dispatch', async () => {
    await recovery.interrupt(gameId);
    const prepared = await recovery.prepareResume(gameId, manifest.fingerprint);
    await expect(recovery.prepareResume(gameId, 'changed-fingerprint')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(prepared);
    const expired = await prisma.gameExecution.update({
      where: { gameId },
      data: { deadline: new Date(Date.now() - 1_000) },
    });
    await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(expired);
  });

  it('renewDispatch advances concurrent retries once and fences the replaced worker', async () => {
    const originalEvent = await run(() => recovery.effect('vote', (tx) => event(tx)));
    await recovery.interrupt(gameId);
    const prepared = await recovery.prepareResume(gameId, manifest.fingerprint);
    const [first, second] = await Promise.all([
      recovery.renewDispatch(gameId, prepared.generation),
      recovery.renewDispatch(gameId, prepared.generation),
    ]);
    expect(first).toEqual(second);
    expect(first).toEqual({ ...prepared, generation: prepared.generation + 1 });
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(first);
    const staleWorker = jest.fn().mockResolvedValue(undefined);
    await expect(
      recovery.run(prepared, new AbortController().signal, staleWorker),
    ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    expect(staleWorker).not.toHaveBeenCalled();
    const duplicateVote = jest.fn().mockRejectedValue(new Error('checkpoint must survive renewal'));
    await expect(
      recovery.run(first, new AbortController().signal, () =>
        recovery.effect('vote', duplicateVote),
      ),
    ).resolves.toEqual(originalEvent);
    expect(duplicateVote).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(1);
    expect(await steps()).toHaveLength(1);
  });

  it('renewDispatch refuses claimed execution and a terminal game even with a stale dispatch flag', async () => {
    await recovery.interrupt(gameId);
    const prepared = await recovery.prepareResume(gameId, manifest.fingerprint);
    await recovery.run(prepared, new AbortController().signal, async () => {
      const claimed = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
      await expect(recovery.renewDispatch(gameId, prepared.generation)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(claimed);
    });
    const released = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    await expect(recovery.renewDispatch(gameId, prepared.generation - 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(released);

    await prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.FINISHED, endedAt: new Date() },
    });
    const terminal = await prisma.gameExecution.update({
      where: { gameId },
      data: { dispatchPending: true },
    });
    await expect(recovery.renewDispatch(gameId, terminal.generation)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(terminal);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.FINISHED,
    );
  });

  it('renewDispatch preserves the original pending dispatch when its transaction fails', async () => {
    await run(() => recovery.effect('vote', (tx) => event(tx)));
    await recovery.interrupt(gameId);
    const prepared = await recovery.prepareResume(gameId, manifest.fingerprint);
    const gameBefore = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    const stepsBefore = await steps();
    const eventsBefore = await events();
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schema}"."game_executions" ADD CONSTRAINT recovery_reject_renewal CHECK (game_id <> '${gameId}'::uuid OR generation <= ${prepared.generation}) NOT VALID`,
    );
    try {
      await expect(recovery.renewDispatch(gameId, prepared.generation)).rejects.toThrow(
        'recovery_reject_renewal',
      );
      expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(prepared);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toEqual(gameBefore);
      expect(await steps()).toEqual(stepsBefore);
      expect(await events()).toEqual(eventsBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."game_executions" DROP CONSTRAINT recovery_reject_renewal`,
      );
    }
    const retry = await recovery.renewDispatch(gameId, prepared.generation);
    expect(retry).toEqual({ ...prepared, generation: prepared.generation + 1 });
  });

  it('does not grant recovery to legacy games without a checkpoint', async () => {
    await prisma.gameExecution.delete({ where: { gameId } });
    await prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.PENDING_RECOVERY },
    });
    await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.PENDING_RECOVERY,
    );
    expect(await prisma.gameExecution.findUnique({ where: { gameId } })).toBeNull();
  });

  it.each([
    {
      description: 'code/config fingerprint mismatch',
      stored: manifest,
      fingerprint: 'different-code',
    },
    {
      description: 'unsupported checkpoint version',
      stored: { ...manifest, version: 2 },
      fingerprint: manifest.fingerprint,
    },
  ])('rejects $description without modifying recovery state', async ({ stored, fingerprint }) => {
    await recovery.interrupt(gameId);
    await prisma.gameExecution.update({
      where: { gameId },
      data: { manifest: encodeRecoveryValue(stored) },
    });
    const before = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
    await expect(recovery.prepareResume(gameId, fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } })).toEqual(before);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.PENDING_RECOVERY,
    );
  });

  it('does not extend an expired original execution deadline', async () => {
    await recovery.interrupt(gameId);
    await prisma.gameExecution.update({
      where: { gameId },
      data: { deadline: new Date(Date.now() - 1_000) },
    });
    await expect(recovery.prepareResume(gameId, manifest.fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      GAME_STATUSES.PENDING_RECOVERY,
    );
  });
});
