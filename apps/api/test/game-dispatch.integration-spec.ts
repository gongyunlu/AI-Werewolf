import { randomUUID } from 'node:crypto';
import { Logger, type DynamicModule } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { GamesService } from '../src/games/games.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { createMockGame, type MockGame } from '../src/game-engine/testing/mock-game-harness';
import { MockGameStore } from '../src/game-engine/testing/mock-game-store';
import { Queue, QueueEvents, Worker, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import {
  GameQueueService,
  createGameProducerQueue,
  type GameJobData,
} from '../src/game-queue/game-queue.service';
import { GameDispatchService } from '../src/game-queue/game-dispatch.service';
import { GameQueueModule } from '../src/game-queue/game-queue.module';
import { GameLaunchService } from '../src/games/game-launch.service';
import { GameResumeService } from '../src/games/game-resume.service';
import {
  ExecutionOwnershipError,
  GameRecoveryService,
} from '../src/game-recovery/game-recovery.service';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import { encodeRecoveryValue } from '../src/game-recovery/recovery-value';
import * as roleAssignment from '../src/game-engine/rules/role-assignment';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve as resolvePath } from 'node:path';
import { GamesController } from '../src/games/games.controller';
import type { ExperimentSnapshot } from '../src/evaluation/experiment-snapshot';
import type { Prisma } from '../src/generated/prisma/client';
import { decodeRecoveryValue } from '../src/game-recovery/recovery-value';
import { createServer, createConnection, type Socket } from 'node:net';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

describe('启动投递：隔离数据库与脚本模型', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let game: MockGame;
  let games: GamesService;
  let gameId: string;
  let connection: Redis;
  let queue: Queue<GameJobData>;
  let queueEvents: QueueEvents;
  let worker: Worker | undefined;
  let delivery: GameQueueService;
  let dispatch: GameDispatchService;
  let launch: GameLaunchService;
  let prefix: string;

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
    await prisma.ruleset.create({
      data: {
        id: 'standard6p',
        name: '六人启动测试',
        playerCount: 6,
        definition: {
          roles: new MockGameStore().players.map(({ role, faction }) => ({ role, faction })),
        },
      },
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试禁止真实模型和平台请求'));
    const row = await prisma.game.create({
      data: {
        rulesetId: 'standard6p',
        skillVersion: 'v1',
        status: 'created',
      },
    });
    gameId = row.id;
    for (const template of new MockGameStore().players) {
      const agent = await prisma.agent.create({
        data: {
          name: randomUUID(),
          defaultModelName: template.modelName,
          memoryLabel: 'default',
        },
      });
      const { id: _id, agentId: _agentId, gameId: _gameId, ...data } = template;
      await prisma.player.create({
        data: {
          ...data,
          gameId,
          agentId: agent.id,
          seatNo: null,
          role: null,
          faction: null,
        },
      });
    }
    game = await createMockGame('villager', {}, { prisma, gameId, recovery: true });
    games = new GamesService(
      prisma,
      game.executor,
      game.broadcaster as never,
      {
        get: () => 'https://mock.invalid',
      } as never,
    );
    prefix = 'dispatch_test_' + randomUUID().replaceAll('-', '');
    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue<GameJobData>('game-queue', { connection, prefix });
    queueEvents = new QueueEvents('game-queue', { connection, prefix });
    await queueEvents.waitUntilReady();
    delivery = new GameQueueService(queue, prisma);
    dispatch = new GameDispatchService(prisma, delivery, game.recovery!);
    launch = new GameLaunchService(games, dispatch);
    const assign = roleAssignment.assignRolesAndSeats;
    jest.spyOn(roleAssignment, 'assignRolesAndSeats').mockImplementation((...args) => {
      const shuffle = jest.spyOn(Math, 'random').mockReturnValue(0.999999);
      try {
        return assign(...args);
      } finally {
        shuffle.mockRestore();
      }
    });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await dispatch?.onModuleDestroy();
    await queueEvents?.close();
    if (!/^dispatch_test_[a-f0-9]{32}$/.test(prefix)) throw new Error('拒绝清理非测试队列');
    await queue?.obliterate({ force: true });
    await queue?.close();
    await connection?.quit();
    await game?.close();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await database?.close();
  });

  const execution = () => prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
  async function consume() {
    const job = await delivery.getJob(gameId);
    if (!job) throw new Error('没有补投任务');
    worker = new Worker('game-queue', (queuedJob) => game.worker.process(queuedJob), {
      connection,
      prefix,
    });
    await job.waitUntilFinished(queueEvents, 20_000);
    return prisma.game.findUniqueOrThrow({ where: { id: gameId } });
  }

  it.each([0, 1])('Redis URL 指定 DB %s 时，生产模块配置的消费者能完成已接受对局', async (db) => {
    const redisUrl = new URL(process.env.REDIS_URL!);
    redisUrl.pathname = `/${db}`;
    if (!/^dispatch_test_[a-f0-9]{32}$/.test(prefix)) throw new Error('拒绝操作非测试队列');
    // 直接装配生产模块的共享配置，避免测试自行拼连接而漏掉生产端与消费端的差异。
    const imports = Reflect.getMetadata('imports', GameQueueModule) as DynamicModule[];
    const sharedConfig = imports.find((item) => item.module === BullModule && item.global);
    if (!sharedConfig) throw new Error('缺少游戏队列共享配置');
    const moduleRef = await Test.createTestingModule({
      imports: [sharedConfig, BullModule.registerQueue({ name: 'game-queue', prefix })],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ REDIS_URL: redisUrl.toString() }))
      .compile();
    const consumerQueue = moduleRef.get<Queue>(getQueueToken('game-queue'));
    const producer = createGameProducerQueue(redisUrl.toString(), prefix);
    const events = new QueueEvents('game-queue', {
      connection: { url: redisUrl.toString() },
      prefix,
    });
    let configuredWorker: Worker | undefined;
    try {
      const client = await producer.getBackend().client;
      if (client.status !== 'ready')
        await new Promise<void>((accept) => client.once('ready', accept));
      await events.waitUntilReady();
      await consumerQueue.waitUntilReady();
      const configuredDelivery = new GameQueueService(producer, prisma);
      const configuredDispatch = new GameDispatchService(
        prisma,
        configuredDelivery,
        game.recovery!,
      );
      await new GameLaunchService(games, configuredDispatch).start(gameId);
      const job = (await configuredDelivery.getJob(gameId))!;
      configuredWorker = new Worker('game-queue', (queuedJob) => game.worker.process(queuedJob), {
        connection: consumerQueue.opts.connection,
        prefix,
      });
      await job.waitUntilFinished(events, 5_000);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
        status: 'finished',
      });
      expect(await execution()).toMatchObject({ dispatchPending: false, owner: null });
      expect(await prisma.event.count({ where: { gameId, actionType: 'game_started' } })).toBe(1);
      expect(await prisma.event.count({ where: { gameId, actionType: 'game_ended' } })).toBe(1);
    } finally {
      await configuredWorker?.close();
      await events.close();
      await producer.obliterate({ force: true });
      await producer.close();
      await moduleRef.close();
    }
  });

  it('数据库接受启动后进程退出，持久意图仍足以由新进程投递', async () => {
    const child = promisify(execFile)(
      process.execPath,
      [
        '--experimental-vm-modules',
        require.resolve('jest/bin/jest'),
        '--config',
        './test/jest-game-recovery-integration.json',
        '--runInBand',
        '--testRegex',
        'dispatch-crash-child\\.ts$',
        '--runTestsByPath',
        './test/helpers/dispatch-crash-child.ts',
      ],
      {
        cwd: resolvePath(__dirname, '..'),
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          DISPATCH_TEST_DATABASE: database.connectionString,
          DISPATCH_TEST_GAME: gameId,
        },
      },
    );
    await expect(child).rejects.toMatchObject({ code: 73 });
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'running',
    });
    expect(await prisma.gameExecution.findUnique({ where: { gameId } })).toMatchObject({
      dispatchPending: true,
      owner: null,
      deadline: null,
    });
    await game.close();
    game = await createMockGame('villager', {}, { prisma, gameId, recovery: true });
    const restarted = new GameDispatchService(prisma, delivery, game.recovery!);
    try {
      await restarted.onApplicationBootstrap();
    } finally {
      await restarted.onModuleDestroy();
    }
    expect(await consume()).toMatchObject({ status: 'finished' });
    expect((await execution()).dispatchPending).toBe(false);
  }, 60_000);

  it.each([false, true])('Redis %s 接收后报告错误，重试和扫描仍只有一个任务', async (received) => {
    const add = delivery.addGameJob.bind(delivery);
    const fault = jest.spyOn(delivery, 'addGameJob').mockImplementationOnce(async (...args) => {
      if (received) await add(...args);
      throw new Error('Redis 响应丢失');
    });
    await expect(launch.start(gameId)).rejects.toThrow('Redis 响应丢失');
    const accepted = await execution();
    fault.mockRestore();
    await Promise.all([launch.start(gameId), dispatch.dispatchPending()]);
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await execution()).toEqual(accepted);
    expect(await consume()).toMatchObject({ status: 'finished' });
  });

  it('并发初始化、启动与重复投递只接受一份角色、输入和任务', async () => {
    await Promise.all([
      games.initializeGame(gameId),
      ...Array.from({ length: 5 }, () => launch.start(gameId)),
    ]);
    const accepted = await execution();
    const players = await prisma.player.findMany({ where: { gameId }, orderBy: { seatNo: 'asc' } });
    await Promise.all(Array.from({ length: 5 }, () => dispatch.dispatch(gameId)));
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await prisma.gameExecution.count({ where: { gameId } })).toBe(1);
    expect(await prisma.player.findMany({ where: { gameId }, orderBy: { seatNo: 'asc' } })).toEqual(
      players,
    );
    expect(await execution()).toEqual(accepted);
    const preparing = jest.spyOn(game.executor, 'prepareExecution');
    await launch.start(gameId);
    expect(preparing).not.toHaveBeenCalled();
    expect(await consume()).toMatchObject({ status: 'finished' });
  });

  it('两个不同分配同时初始化，只有获胜分配可以进入冻结状态', async () => {
    const firstRead = deferred();
    const allowFirst = deferred();
    const find = prisma.game.findUnique.bind(prisma.game);
    jest.spyOn(prisma.game, 'findUnique').mockImplementationOnce((async (
      ...args: Parameters<typeof find>
    ) => {
      const result = await find(...args);
      firstRead.resolve();
      await allowFirst.promise;
      return result;
    }) as never);
    const assignment = jest.mocked(roleAssignment.assignRolesAndSeats);
    const assign = assignment.getMockImplementation()!;
    let count = 0;
    assignment.mockImplementation((...args) => {
      const rows = assign(...args);
      return ++count === 1
        ? rows
        : rows.map((row) => Object.assign({}, row, { seatNo: 7 - row.seatNo }));
    });
    const first = games.initializeGame(gameId);
    await firstRead.promise;
    const winner = await games.initializeGame(gameId);
    allowFirst.resolve();
    await first;
    expect(count).toBe(2);
    await games.startGame(gameId);
    const frozen = decodeRecoveryValue<{
      players: Array<{ id: string; role: string; seatNo: number }>;
    }>((await execution()).initialState);
    expect(frozen.players.map(({ id, role, seatNo }) => ({ id, role, seatNo }))).toEqual(
      winner.players.map(({ id, role, seatNo }) => ({ id, role, seatNo })),
    );
  });

  it('准备失败保留初始化结果，执行记录写入失败则整笔启动回滚', async () => {
    const prepare = jest
      .spyOn(game.executor, 'prepareExecution')
      .mockRejectedValueOnce(new Error('技能缺失'));
    await expect(launch.start(gameId)).rejects.toThrow('技能缺失');
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'initialized',
    });
    expect(await prisma.gameExecution.count({ where: { gameId } })).toBe(0);
    prepare.mockRestore();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE game_executions ADD CONSTRAINT reject_start CHECK (NOT dispatch_pending) NOT VALID',
    );
    try {
      await expect(launch.start(gameId)).rejects.toThrow('reject_start');
      expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
        status: 'initialized',
      });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE game_executions DROP CONSTRAINT reject_start');
    }
    await launch.start(gameId);
  });

  it('同时领取以及释放 owner 后的重复任务都不能再次执行本代', async () => {
    await games.startGame(gameId);
    const accepted = await execution();
    const entered = deferred();
    const release = deferred();
    const first = game.recovery!.run(
      accepted,
      new AbortController().signal,
      async () => {
        entered.resolve();
        await release.promise;
      },
      60_000,
    );
    await entered.promise;
    const duplicate = new GameRecoveryService(prisma);
    try {
      await expect(
        duplicate.run(accepted, new AbortController().signal, async () => {}, 60_000),
      ).rejects.toBeInstanceOf(ExecutionOwnershipError);
    } finally {
      release.resolve();
      await first;
    }
    expect((await execution()).owner).toBeNull();
    await expect(
      duplicate.run(accepted, new AbortController().signal, async () => {}, 60_000),
    ).rejects.toBeInstanceOf(ExecutionOwnershipError);
  });

  it.each(['入队前', '入队后'] as const)(
    '补投与取消竞争（%s），残留任务不能启动引擎',
    async (point) => {
      await games.startGame(gameId);
      const reached = deferred();
      const release = deferred();
      const add = delivery.addGameJob.bind(delivery);
      jest.spyOn(delivery, 'addGameJob').mockImplementationOnce(async (...args) => {
        if (point === '入队后') await add(...args);
        reached.resolve();
        await release.promise;
        return point === '入队前' ? add(...args) : gameId;
      });
      const pending = dispatch.dispatch(gameId);
      await reached.promise;
      try {
        await games.cancelGame(gameId);
      } finally {
        release.resolve();
        await pending;
      }
      expect((await execution()).dispatchPending).toBe(false);
      expect(await consume()).toMatchObject({ status: 'aborted' });
      expect(game.execution).not.toHaveBeenCalled();
      await launch.start(gameId);
      expect(await prisma.event.count({ where: { gameId } })).toBe(0);
    },
  );

  it('取消已领取任务后，旧执行者不能提交事件', async () => {
    await games.startGame(gameId);
    const target = await prisma.player.findFirstOrThrow({ where: { gameId, seatNo: 1 } });
    await game.recovery!.run(
      await execution(),
      new AbortController().signal,
      async () => {
        await games.cancelGame(gameId);
        const writer = new EventWriterService(prisma, game.recovery);
        await expect(
          writer.commitExile({
            gameId,
            phaseInstanceId: 'node/0/test',
            day: 1,
            targetId: target.id,
            targetSeatNo: 1,
            voteCount: 3,
          }),
        ).rejects.toBeInstanceOf(ExecutionOwnershipError);
      },
      60_000,
    );
    expect(await prisma.event.count({ where: { gameId } })).toBe(0);
  });

  it('排队不计时，恢复保留首次领取的期限，过期不能获得新期限', async () => {
    await launch.start(gameId);
    const accepted = await execution();
    expect(accepted.deadline).toBeNull();
    const before = Date.now();
    await game.recovery!.run(accepted, new AbortController().signal, async () => {}, 30_000);
    const claimed = await execution();
    expect(claimed.deadline!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    await game.recovery!.interrupt(gameId, claimed.generation);
    const resumed = await game.recovery!.prepareResume(gameId);
    expect(resumed.deadline).toEqual(claimed.deadline);
    await prisma.gameExecution.update({
      where: { gameId },
      data: { deadline: new Date(Date.now() - 1) },
    });
    await expect(game.recovery!.prepareResume(gameId)).rejects.toThrow('期限');
    await expect(
      game.recovery!.run(resumed, new AbortController().signal, async () => {}, 60_000),
    ).rejects.toThrow('期限');
  });

  it('已执行却缺少期限的数据不能重新计时', async () => {
    await games.startGame(gameId);
    await prisma.gameExecution.update({ where: { gameId }, data: { heartbeatAt: new Date() } });
    await expect(
      game.recovery!.run(await execution(), new AbortController().signal, async () => {}, 60_000),
    ).rejects.toThrow('缺少原定期限');
  });

  it('启动接受事务尚未提交时取消，按原锁顺序重试并撤销刚建立的意图', async () => {
    await games.initializeGame(gameId);
    const reached = deferred();
    const release = deferred();
    let blockerPid = 0;
    const transaction = prisma.$transaction.bind(prisma);
    const fault = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      transaction(async (tx) => {
        const result = await callback(tx);
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = row.pid;
        reached.resolve();
        await release.promise;
        return result;
      })) as never);
    const starting = games.startGame(gameId);
    await reached.promise;
    const cancelling = games.cancelGame(gameId);
    try {
      const until = Date.now() + 2_000;
      for (;;) {
        const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${blockerPid}::integer = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        if (row.blocked) break;
        if (Date.now() > until) throw new Error('取消事务未到达预期行锁');
        await new Promise((accept) => setTimeout(accept, 10));
      }
    } finally {
      release.resolve();
      fault.mockRestore();
    }
    await Promise.all([starting, cancelling]);
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'aborted',
    });
    expect(await execution()).toMatchObject({
      dispatchPending: false,
      owner: null,
      deadline: null,
    });
    await dispatch.dispatchPending();
    expect(await queue.getWaitingCount()).toBe(0);
  });

  it('取消发生在外部输入准备期间，启动不能覆盖终态', async () => {
    await games.initializeGame(gameId);
    const reached = deferred();
    const release = deferred();
    const prepare = game.executor.prepareExecution.bind(game.executor);
    jest.spyOn(game.executor, 'prepareExecution').mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      reached.resolve();
      await release.promise;
      return result;
    });
    const starting = games.startGame(gameId);
    const rejected = expect(starting).rejects.toThrow('状态已变化');
    await reached.promise;
    try {
      await games.cancelGame(gameId);
    } finally {
      release.resolve();
    }
    await rejected;
    expect(await prisma.gameExecution.count({ where: { gameId } })).toBe(0);
  });

  it('Redis 不可用时取消接口仍提交取消并阻止迟到的任务', async () => {
    await launch.start(gameId);
    const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const controller = new GamesController(games, launch, delivery, logger as never, {} as never);
    jest.spyOn(delivery, 'cancelJob').mockRejectedValueOnce(new Error('Redis 不可用'));
    await expect(controller.cancel(gameId)).resolves.toMatchObject({
      success: true,
      removedFromQueue: false,
    });
    expect((await execution()).dispatchPending).toBe(false);
    expect(await consume()).toMatchObject({ status: 'aborted' });
  });

  it('真实 TCP 丢弃 Redis 响应时投递有界失败，恢复连接后可用原意图继续', async () => {
    await games.startGame(gameId);
    const target = new URL(process.env.REDIS_URL!);
    const sockets = new Set<Socket>();
    let dropResponses = false;
    const proxy = createServer((client) => {
      const upstream = createConnection({
        host: target.hostname,
        port: Number(target.port) || 6379,
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      }
      client.on('data', (data) => upstream.write(data));
      upstream.on('data', (data) => {
        if (!dropResponses) client.write(data);
      });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((accept) => proxy.listen(0, '127.0.0.1', accept));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('测试代理地址无效');
    const proxyUrl = new URL(target);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(address.port);
    const producer = createGameProducerQueue(proxyUrl.toString(), prefix);
    const bounded = new GameDispatchService(
      prisma,
      new GameQueueService(producer, prisma),
      game.recovery!,
    );
    try {
      const client = await producer.getBackend().client;
      if (client.status !== 'ready')
        await new Promise<void>((accept) => client.once('ready', accept));
      dropResponses = true;
      const began = Date.now();
      await expect(bounded.dispatch(gameId)).rejects.toThrow(/timed out/i);
      expect(Date.now() - began).toBeLessThan(8_000);
      expect((await execution()).dispatchPending).toBe(true);
      // TCP 正常情况下不会漏掉中间字节；故障恢复必须重连，重新建立响应顺序。
      const ready = new Promise<void>((accept) => client.once('ready', accept));
      for (const socket of sockets) socket.destroy();
      dropResponses = false;
      await ready;
      await bounded.dispatch(gameId);
      expect(await consume()).toMatchObject({ status: 'finished' });
    } finally {
      await producer.disconnect();
      await producer.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept) => proxy.close(() => accept()));
    }
  });

  it('待投递记录版本不受支持时，在领取和模型请求前明确失败', async () => {
    await launch.start(gameId);
    await prisma.gameExecution.update({
      where: { gameId },
      data: {
        manifest: encodeRecoveryValue({
          version: 999,
          prompts: { test: { text: '旧模板', version: 1 } },
        }),
      },
    });
    await expect(consume()).rejects.toThrow('不受支持');
    expect(await prisma.event.count({ where: { gameId } })).toBe(0);
    expect((await execution()).deadline).toBeNull();
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'aborted',
    });
  });

  it('实验启动冻结原实验输入，领取前可补投，领取后中断判无效而不续跑', async () => {
    await games.initializeGame(gameId);
    const row = await prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      include: { players: { orderBy: { seatNo: 'asc' } } },
    });
    const prepared = await game.executor.prepareExecution(row);
    const snapshot: ExperimentSnapshot = {
      version: 1,
      experimentId: '启动测试',
      pairId: '配对一',
      arm: 'off',
      capturedAt: new Date().toISOString(),
      memories: [],
      globalPatterns: [],
      knowledgeChunkIds: [],
      prompts: prepared.manifest.prompts,
      skills: {},
      embeddingModel: '脚本向量',
      judgeModel: '脚本裁判',
      auxiliaryModel: '脚本辅助',
      roleContexts: {},
      assignments: row.players.map((p) => ({
        agentId: p.agentId,
        seatNo: p.seatNo!,
        role: p.role!,
        faction: p.faction!,
        modelName: p.modelName,
        memoryLabel: p.memoryLabelSnapshot,
      })),
    };
    await prisma.game.update({
      where: { id: gameId },
      data: { experiment: snapshot as unknown as Prisma.InputJsonValue },
    });
    await launch.start(gameId);
    expect(decodeRecoveryValue((await execution()).manifest)).toEqual(prepared.manifest);
    expect(await game.recovery!.interrupt(gameId)).toBe(false);
    await dispatch.dispatchPending();
    expect(await queue.getWaitingCount()).toBe(1);
    await game.recovery!.run(
      await execution(),
      new AbortController().signal,
      async () => {},
      60_000,
    );
    await game.recovery!.interrupt(gameId);
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'aborted',
    });
    await expect(game.recovery!.prepareResume(gameId)).rejects.toThrow('只支持');
  });

  it.each(['其他板型', '不支持版本'] as const)(
    '有执行记录的%s仍不获得普通局恢复资格',
    async (kind) => {
      await games.startGame(gameId);
      if (kind === '其他板型') {
        await prisma.ruleset.upsert({
          where: { id: 'unsupported' },
          update: {},
          create: { id: 'unsupported', name: '测试', playerCount: 6, definition: {} },
        });
        await prisma.game.update({ where: { id: gameId }, data: { rulesetId: 'unsupported' } });
      }
      await dispatch.dispatch(gameId);
      expect(await delivery.getJob(gameId)).toBeDefined();
      await game.recovery!.run(
        await execution(),
        new AbortController().signal,
        async () => {},
        60_000,
      );
      if (kind === '不支持版本')
        await prisma.gameExecution.update({
          where: { gameId },
          data: { manifest: encodeRecoveryValue({ version: 999, prompts: {} }) },
        });
      await game.recovery!.interrupt(gameId);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
        status: 'aborted',
      });
      await expect(game.recovery!.prepareResume(gameId)).rejects.toThrow('只支持');
    },
  );

  it.each(['completed', 'failed'])(
    '领取前失锁只补投，%s 任务换代不会重新分配角色',
    async (state) => {
      await launch.start(gameId);
      const before = await execution();
      const job = (await delivery.getJob(gameId))!;
      await expect(game.worker.process({ ...job, stalledCounter: 1 } as never)).rejects.toThrow(
        '中断',
      );
      expect(await execution()).toEqual(before);
      worker = new Worker(
        'game-queue',
        async () => {
          if (state === 'failed') throw new UnrecoverableError('领取前错误');
        },
        { connection, prefix },
      );
      if (state === 'failed')
        await expect(job.waitUntilFinished(queueEvents, 10_000)).rejects.toThrow('领取前错误');
      else await job.waitUntilFinished(queueEvents, 10_000);
      await worker.close();
      worker = undefined;
      await Promise.all([dispatch.dispatch(gameId), dispatch.dispatch(gameId)]);
      const next = await execution();
      expect(next.generation).toBe(before.generation + 1);
      expect(next.initialState).toEqual(before.initialState);
      expect(next.deadline).toBeNull();
      expect(await consume()).toMatchObject({ status: 'finished' });
    },
  );

  it('恢复投递失败后由新扫描器补投，旧代不能中断新代', async () => {
    await games.startGame(gameId);
    await game.recovery!.run(
      await execution(),
      new AbortController().signal,
      async () => {},
      60_000,
    );
    const old = await execution();
    await game.recovery!.interrupt(gameId);
    const fault = jest
      .spyOn(delivery, 'addGameJob')
      .mockRejectedValueOnce(new Error('恢复投递失败'));
    const resume = new GameResumeService(dispatch, game.recovery!, games);
    await expect(resume.resume(gameId)).rejects.toThrow('恢复投递失败');
    fault.mockRestore();
    const accepted = await execution();
    await Promise.all([resume.resume(gameId), dispatch.dispatchPending()]);
    expect(await game.recovery!.interrupt(gameId, old.generation)).toBe(false);
    expect(await execution()).toEqual(accepted);
    expect(await queue.getWaitingCount()).toBe(1);
    expect(await consume()).toMatchObject({ status: 'finished' });
  });
});
