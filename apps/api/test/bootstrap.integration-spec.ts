import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ACTION_TYPES, GAME_STATUSES } from '@ai-werewolf/shared';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { ChatHistoryService } from '../src/agent-runtime/chat-history.service';
import { getPlayerThreadId } from '../src/agent-runtime/thread-id.utils';
import { GamesService } from '../src/games/games.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createMockGame, type MockGame } from '../src/game-engine/testing/mock-game-harness';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

describe('首版正式迁移、seed 与持久化完整对局', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('初始化测试禁止外部模型请求'));
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await database?.close();
  });

  const seed = () => database.runPrisma('db', 'seed');
  const bases = async () => ({
    rulesets: await prisma.ruleset.findMany({ orderBy: { id: 'asc' }, select: { id: true } }),
    agents: await prisma.agent.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    memories: await prisma.memory.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, agentId: true, type: true, title: true, content: true, isActive: true },
    }),
  });

  it('空库通过全部正式迁移，包含会话表及两个向量失效触发器', async () => {
    const migrations = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
    );
    expect(migrations.map((row) => row.migration_name)).toEqual(
      expect.arrayContaining([
        '20260805111036_init',
        '20260827134250_normalize_memory_storage',
        '20260910064110_game_execution_checkpoints',
        '20260910071232_game_recovery_dispatch',
      ]),
    );
    const triggers = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      'SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname',
    );
    expect(triggers.map((row) => row.tgname)).toEqual([
      'global_memories_invalidate_embedding_on_content_change',
      'memories_invalidate_embedding_on_content_change',
    ]);
    const history = new ChatHistoryService(
      new Pool({ connectionString: database.connectionString }),
    );
    try {
      await history.onModuleInit();
    } finally {
      await history.onModuleDestroy();
    }
  });

  it('重复seed保持基础记录ID，不创建示例局，也不覆盖已有对局或事件', async () => {
    await seed();
    expect(await prisma.game.count()).toBe(0);
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.event.count()).toBe(0);
    expect(await prisma.gameExecution.count()).toBe(0);
    const initial = await bases();
    expect(initial.rulesets).toHaveLength(1);
    expect(initial.agents).toHaveLength(6);
    expect(initial.memories.length).toBeGreaterThan(0);
    const game = await prisma.game.create({
      data: {
        id: '00000000-0000-0000-0000-000000000001',
        rulesetId: 'standard6p',
        skillVersion: 'v1',
        status: GAME_STATUSES.FINISHED,
        winnerFaction: 'villager',
        totalDays: 2,
        startedAt: new Date('2026-09-01T00:00:00Z'),
        endedAt: new Date('2026-09-01T01:00:00Z'),
      },
    });
    const event = await prisma.event.create({
      data: {
        gameId: game.id,
        sequence: 1,
        day: 2,
        phase: 'check_win',
        actionType: ACTION_TYPES.GAME_ENDED,
        visibility: 'public',
        content: { winner: 'villager' },
      },
    });
    const player = await prisma.player.create({
      data: {
        gameId: game.id,
        agentId: initial.agents[0].id,
        seatNo: 1,
        role: 'villager',
        faction: 'villager',
        displayName: '保留已有玩家',
        modelName: 'mock',
        memoryLabelSnapshot: 'existing',
        deathDay: 2,
        deathCause: 'execution',
      },
    });
    await seed();
    expect(await bases()).toEqual(initial);
    expect(await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).toEqual(game);
    expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    expect(await prisma.player.findUniqueOrThrow({ where: { id: player.id } })).toEqual(player);
    expect(await prisma.game.count()).toBe(1);
  });

  it('正式迁移的内容触发器清除过期向量元数据', async () => {
    await seed();
    const memory = await prisma.memory.findFirstOrThrow();
    const vector = '[' + [1, ...Array<number>(2047).fill(0)].join(',') + ']';
    await prisma.$executeRawUnsafe(
      'UPDATE memories SET embedding=$1::vector, embedding_model=$2, embedding_dimension=2048, ' +
        'embedding_content_hash=$3, embedded_at=now() WHERE id=$4::uuid',
      vector,
      'mock-embedding',
      'a'.repeat(64),
      memory.id,
    );
    await prisma.memory.update({ where: { id: memory.id }, data: { content: randomUUID() } });
    const changed = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(changed).toMatchObject({
      embeddingModel: null,
      embeddingDimension: null,
      embeddingContentHash: null,
      embeddedAt: null,
    });
    const [raw] = await prisma.$queryRawUnsafe<Array<{ empty: boolean }>>(
      'SELECT embedding IS NULL AS empty FROM memories WHERE id=$1::uuid',
      memory.id,
    );
    expect(raw.empty).toBe(true);
  });

  it('seed后经正常建局、初始化、启动和Worker完成mock整局，历史与恢复效果写入同一独立库', async () => {
    await seed();
    const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } });
    const broadcaster = { getOrCreate: jest.fn() };
    const games = new GamesService(prisma, {} as never, broadcaster as never);
    const created = await games.createGame({
      rulesetId: 'standard6p',
      agentIds: agents.map((a) => a.id),
    });
    expect(created.status).toBe(GAME_STATUSES.CREATED);
    const shuffle = jest.spyOn(Math, 'random').mockReturnValue(0.999999);
    const initialized = await games.initializeGame(created.id);
    shuffle.mockRestore();
    expect(initialized.status).toBe(GAME_STATUSES.INITIALIZED);
    expect(initialized.players.map((p) => p.role)).toEqual([
      'werewolf',
      'werewolf',
      'seer',
      'witch',
      'villager',
      'villager',
    ]);
    // 只替换本测试局的外部模型，座次与角色仍由正常初始化路径生成。
    for (const player of initialized.players)
      await prisma.player.update({
        where: { id: player.id },
        data: { modelName: 'mock-seat-' + player.seatNo },
      });
    expect((await games.startGame(created.id)).status).toBe(GAME_STATUSES.RUNNING);
    const history = new ChatHistoryService(
      new Pool({ connectionString: database.connectionString }),
    );
    let game: MockGame | undefined;
    try {
      await history.onModuleInit();
      game = await createMockGame(
        'villager',
        {},
        {
          prisma,
          gameId: created.id,
          recovery: true,
          chatHistory: history,
        },
      );
      await game.run();
      expect(await prisma.game.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
        status: GAME_STATUSES.FINISHED,
        winnerFaction: 'villager',
        totalDays: 2,
      });
      const events = await prisma.event.findMany({
        where: { gameId: created.id },
        orderBy: { sequence: 'asc' },
      });
      expect(events.filter((e) => e.actionType === ACTION_TYPES.GAME_STARTED)).toHaveLength(1);
      expect(events.filter((e) => e.actionType === ACTION_TYPES.GAME_ENDED)).toHaveLength(1);
      expect(events.filter((e) => e.actionType === ACTION_TYPES.NIGHT_RESOLVED)).toHaveLength(2);
      expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);
      expect(
        await prisma.gameExecutionStep.count({ where: { gameId: created.id, completed: false } }),
      ).toBe(0);
      const seer = initialized.players.find((p) => p.role === 'seer')!;
      const committed = await history.load(getPlayerThreadId(created.id, seer.id));
      expect(committed.filter((m) => String(m.content).includes('seer_check'))).toHaveLength(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (game) await game.close();
      else await history.onModuleDestroy();
    }
  });
});
