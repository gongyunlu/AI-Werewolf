import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Worker, type Job, type Queue } from 'bullmq';
import { Prisma } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { MemoryService } from '../src/memory/memory.service';
import { GlobalMemoryService } from '../src/memory/global-memory.service';
import type { EmbeddingService } from '../src/memory/embedding.service';
import { MemoryMaintenanceService } from '../src/memory-maintenance/memory-maintenance.service';
import { PromptService } from '../src/observability/prompt.service';
import type { StructuredLlmService } from '../src/observability/structured-llm.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { withLearningTestQueues } from './helpers/learning-test-queues';
import { EVALUATION_VERSION } from '../src/evaluation/evaluation-version';
import { CURRENT_LEARNING_USAGE_FILTER } from '../src/memory/learning-usage-filter';
import { MaintenanceWorkerService } from '../src/memory-maintenance/maintenance.worker';
import {
  MEMORY_MAINTENANCE_QUEUE,
  MAINTENANCE_JOB_OPTIONS,
} from '../src/memory-maintenance/memory-maintenance.service';
import {
  ReflectionQueueService,
  REFLECT_QUEUE_NAME,
  buildReflectionCompleteJobId,
  type ReflectJobData,
} from '../src/reflection/reflection-queue.service';
import { ReflectionWorkerService } from '../src/reflection/reflection.worker';
import { ReflectionService } from '../src/reflection/reflection.service';
import { JudgeService } from '../src/evaluation/judge.service';
import { loadKnowledgeScoredEvents } from '../src/evaluation/learning-knowledge-comparison';
import { GameReviewService } from '../src/reflection/game-review.service';
import type { RedisService } from '../src/redis/redis.service';
import { createAgentRuntime } from '../src/testing/agent-runtime.fixture';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
import type { SkillLoaderService } from '../src/skills/skill-loader.service';
import type { SpeechSummarizerService } from '../src/speech-summarizer/speech-summarizer.service';
import type { LangfuseService } from '../src/observability/langfuse.service';
import type { KnowledgeService } from '../src/knowledge/knowledge.service';

function vector(axis = 0): number[] {
  return Array.from({ length: 2048 }, (_, i) => (i === axis ? 1 : 0));
}

describe('学习维护：隔离 PostgreSQL/pgvector', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let memories: MemoryService;
  let globalMemories: GlobalMemoryService;
  let maintenance: MemoryMaintenanceService;
  let agentId: string;
  let rulesetId: string;
  const embedding = {
    model: 'test-embedding',
    dimension: 2048,
    embedText: jest.fn(),
    embedTexts: jest.fn(),
    assertValidVector: jest.fn(),
  };
  const llm = { invoke: jest.fn() };
  const queue = { getJob: jest.fn(), add: jest.fn() };
  const pattern = { title: '规律', content: '发言应说明判断依据', importance: 0.8 };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  });
  afterAll(async () => {
    await database?.close();
    jest.restoreAllMocks();
  });
  beforeEach(async () => {
    await database.reset();
    jest.clearAllMocks();
    embedding.embedText.mockResolvedValue(vector());
    embedding.embedTexts.mockImplementation(async (texts: string[]) => texts.map(() => vector()));
    llm.invoke.mockResolvedValue({
      output: { title: '固化策略', content: '先核对证据再表达判断' },
    });
    memories = new MemoryService(prisma, embedding as unknown as EmbeddingService);
    globalMemories = new GlobalMemoryService(prisma, embedding as unknown as EmbeddingService);
    maintenance = new MemoryMaintenanceService(
      queue as unknown as Queue,
      prisma,
      embedding as unknown as EmbeddingService,
      memories,
      {
        render: jest.fn().mockResolvedValue({ text: 'test', name: 'test', version: null }),
      } as unknown as PromptService,
      llm as unknown as StructuredLlmService,
    );
    const agent = await prisma.agent.create({
      data: { name: randomUUID(), defaultModelName: 'mock', memoryLabel: 'test' },
    });
    agentId = agent.id;
    const ruleset = await prisma.ruleset.create({
      data: { id: randomUUID(), name: 'test', playerCount: 1, definition: {} },
    });
    rulesetId = ruleset.id;
  });

  async function game(index = 1, experiment = false) {
    const g = await prisma.game.create({
      data: {
        rulesetId,
        skillVersion: 'test',
        status: 'finished',
        endedAt: new Date(Date.UTC(2025, 0, 1, 0, index)),
        ...(experiment ? { experiment: { arm: 'on' } } : {}),
        players: {
          create: {
            agentId,
            seatNo: 1,
            role: 'villager',
            faction: 'villager',
            displayName: 'test',
            modelName: 'mock',
            memoryLabelSnapshot: 'test',
          },
        },
      },
      include: { players: true },
    });
    return g;
  }

  async function games(count: number) {
    const rows: Awaited<ReturnType<typeof game>>[] = [];
    for (let i = 1; i <= count; i++) rows.push(await game(i));
    return rows;
  }

  async function scoredVote(
    g: Awaited<ReturnType<typeof game>>,
    sequence = 1,
    version = EVALUATION_VERSION,
  ) {
    const event = await prisma.event.create({
      data: {
        gameId: g.id,
        actorId: g.players[0].id,
        sequence,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        content: {},
      },
    });
    await prisma.decisionJudgment.create({
      data: {
        gameId: g.id,
        playerId: g.players[0].id,
        eventId: event.id,
        actionType: 'vote',
        day: 1,
        score: 80,
        verdict: 'good',
        modelName: 'mock',
        evaluationVersion: version,
      },
    });
    return event;
  }

  async function lesson(
    options: {
      gameId?: string;
      metadata?: Prisma.InputJsonValue;
      confidence?: number;
      importance?: number;
      embedding?: number[];
      type?: string;
      label?: string;
    } = {},
  ) {
    const row = await prisma.memory.create({
      data: {
        agentId,
        label: options.label ?? 'test',
        gameId: options.gameId,
        title: '经验',
        content: randomUUID(),
        type: options.type ?? 'lesson',
        source: 'auto',
        importance: options.importance ?? 0.8,
        confidence: options.confidence ?? 0.5,
        metadata: options.metadata ?? { role: 'any', scenario: 'any', conditions: [] },
      },
    });
    await memories.embedAndStore(row.id, options.embedding ?? vector(), row.content);
    return row;
  }

  async function rejectDerivationWrites(task: () => Promise<unknown>) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE memory_derivations ADD CONSTRAINT test_derivation_failure CHECK (false) NOT VALID',
    );
    try {
      await expect(task()).rejects.toThrow('test_derivation_failure');
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE memory_derivations DROP CONSTRAINT test_derivation_failure',
      );
    }
  }

  it('第三场晋升保留三个来源；后续同一规律不再次晋升', async () => {
    const sources = await games(6);
    for (const g of sources) await globalMemories.promotePatterns(g.id, [pattern]);
    const globals = await prisma.globalMemory.findMany();
    expect(globals).toHaveLength(1);
    expect(globals[0].sourceGameIds).toEqual(sources.slice(0, 3).map((g) => g.id));
    const candidates = await prisma.patternCandidate.findMany();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceGameIds).toEqual(sources.map((g) => g.id));
  });

  it('一次处理的后续候选失败时全部回滚，重试不会遗漏', async () => {
    const g = await game();
    embedding.embedTexts.mockResolvedValue([vector(), vector(1)]);
    const invalid = { ...pattern, title: 'x'.repeat(257), content: '第二条' };
    await expect(globalMemories.promotePatterns(g.id, [pattern, invalid])).rejects.toThrow();
    expect(await prisma.patternCandidate.count()).toBe(0);
    await globalMemories.promotePatterns(g.id, [pattern, { ...invalid, title: '第二条' }]);
    expect(await prisma.patternCandidate.count()).toBe(2);
  });

  it('维护计数排除实验局', async () => {
    const ordinary = await games(49);
    await game(50, true);
    const memory = await lesson();
    expect((await maintenance.runForGame(ordinary[48].id)).decayed).toBe(0);
    expect(
      (await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } })).importance,
    ).toBeCloseTo(0.8);
  });

  it('第50局任务排到第51局之后仍执行原边界，重复执行不再衰减', async () => {
    const sources = await games(51);
    const memory = await lesson({ gameId: sources[0].id });
    expect((await maintenance.runForGame(sources[49].id)).decayed).toBe(1);
    expect((await maintenance.runForGame(sources[49].id)).decayed).toBe(0);
    const saved = await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(saved.importance).toBeCloseTo(0.72);
    expect(saved.metadata).toMatchObject({ maintenance: { lastDecayedGameCount: 50 } });
  });

  it('向量相同但角色、场景或条件不同的经验不能去重', async () => {
    const sources = await games(100);
    const metadata = [
      { role: 'seer', scenario: 'vote', conditions: [] },
      { role: 'villager', scenario: 'vote', conditions: [] },
      { role: 'seer', scenario: 'day_speech', conditions: [] },
      { role: 'seer', scenario: 'vote', conditions: ['public_discussion'] },
    ];
    for (const data of metadata) await lesson({ metadata: data });
    expect((await maintenance.runForGame(sources[99].id)).deduped).toBe(0);
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(4);
  });

  it('跨局并发及同局并发只形成一个簇、一次晋升，来源不丢失', async () => {
    const sources = await games(3);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    embedding.embedTexts.mockImplementation(async (texts: string[]) => {
      if (++arrivals === 4) release();
      await barrier;
      return texts.map(() => vector());
    });
    const counts = await Promise.all(
      [...sources, sources[0]].map((g) => globalMemories.promotePatterns(g.id, [pattern])),
    );
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    const candidates = await prisma.patternCandidate.findMany();
    expect(candidates).toHaveLength(1);
    expect(new Set(candidates[0].sourceGameIds as string[])).toEqual(
      new Set(sources.map((g) => g.id)),
    );
    expect(await prisma.globalMemory.count()).toBe(1);
    const calls = embedding.embedTexts.mock.calls.length;
    await globalMemories.promotePatterns(sources[0].id, [pattern]);
    expect(embedding.embedTexts).toHaveBeenCalledTimes(calls);
  });

  it('同一局重复规律只算一个来源，低于相似度门槛另建候选', async () => {
    const sources = await games(2);
    await globalMemories.promotePatterns(sources[0].id, [pattern, pattern, pattern]);
    expect(await prisma.patternCandidate.count()).toBe(1);
    expect(await prisma.globalMemory.count()).toBe(0);
    const below = vector();
    below[0] = 0.84;
    below[1] = Math.sqrt(1 - 0.84 ** 2);
    embedding.embedTexts.mockResolvedValue([below]);
    await globalMemories.promotePatterns(sources[1].id, [pattern]);
    expect(await prisma.patternCandidate.count()).toBe(2);
  });

  it('事务中向量写入失败不留下无向量候选', async () => {
    const g = await game();
    embedding.embedTexts.mockResolvedValueOnce([[1, 0]]);
    await expect(globalMemories.promotePatterns(g.id, [pattern])).rejects.toThrow();
    expect(await prisma.patternCandidate.count()).toBe(0);
    await globalMemories.promotePatterns(g.id, [pattern]);
    expect(await prisma.patternCandidate.count()).toBe(1);
  });

  it('衰减下限、metadata 保留、类型和标签隔离，以及较旧任务回放', async () => {
    const sources = await games(60);
    const floor = await lesson({
      importance: 0.051,
      metadata: {
        role: 'seer',
        scenario: 'vote',
        conditions: [],
        maintenance: { retained: true },
      },
    });
    const low = await lesson({ importance: 0.01 });
    const otherLabel = await lesson({ label: 'another' });
    const inactive = await lesson();
    await prisma.memory.update({ where: { id: inactive.id }, data: { isActive: false } });
    const protectedMemory = await lesson({ type: 'persona' });
    expect((await maintenance.runForGame(sources[59].id)).decayed).toBe(2);
    expect((await maintenance.runForGame(sources[49].id)).decayed).toBe(0);
    const saved = await prisma.memory.findUniqueOrThrow({ where: { id: floor.id } });
    expect(saved.importance).toBeCloseTo(0.05);
    expect(saved.metadata).toMatchObject({
      maintenance: { retained: true, lastDecayedGameCount: 60 },
    });
    expect(
      (await prisma.memory.findUniqueOrThrow({ where: { id: low.id } })).importance,
    ).toBeCloseTo(0.05);
    for (const row of [otherLabel, inactive, protectedMemory]) {
      expect(
        (await prisma.memory.findUniqueOrThrow({ where: { id: row.id } })).importance,
      ).toBeCloseTo(0.8);
    }
  });

  it('容量500不归档；超过后按最近使用对局驱逐，保护其他类型', async () => {
    const sources = await games(50);
    const hot = await lesson({ gameId: sources[0].id });
    await prisma.memoryUsage.create({
      data: {
        memoryId: hot.id,
        gameId: sources[49].id,
        playerId: sources[49].players[0].id,
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
      },
    });
    const protectedRows: Awaited<ReturnType<typeof lesson>>[] = [];
    for (const type of ['persona', 'strategy', 'player_model'])
      protectedRows.push(await lesson({ type, gameId: sources[0].id }));
    await prisma.memory.createMany({
      data: Array.from({ length: 496 }, () => ({
        agentId,
        label: 'test',
        gameId: sources[49].id,
        type: 'reflection',
        title: '复盘',
        content: '复盘',
      })),
    });
    expect((await maintenance.runForGame(sources[49].id)).archived).toBe(0);
    const cold = [await lesson({ gameId: sources[0].id }), await lesson({ gameId: sources[1].id })];
    expect((await maintenance.runForGame(sources[49].id)).archived).toBe(2);
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(500);
    expect(
      await prisma.memory.count({ where: { id: { in: cold.map((m) => m.id) }, isActive: true } }),
    ).toBe(0);
    expect(
      await prisma.memory.count({
        where: { id: { in: [hot, ...protectedRows].map((m) => m.id) }, isActive: true },
      }),
    ).toBe(4);
    expect((await maintenance.runForGame(sources[49].id)).archived).toBe(0);
  });

  it('去重保留高 confidence 来源，并在溯源写失败时回滚', async () => {
    const sources = await games(100);
    const keeper = await lesson({ confidence: 0.95, gameId: sources[0].id });
    const dropped = await lesson({ confidence: 0.5, gameId: sources[1].id });
    await rejectDerivationWrites(() => maintenance.runForGame(sources[99].id));
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(2);
    expect(await prisma.memoryDerivation.count()).toBe(0);
    expect((await maintenance.runForGame(sources[99].id)).deduped).toBe(1);
    const saved = await prisma.memory.findUniqueOrThrow({ where: { id: keeper.id } });
    expect(saved.confidence).toBeCloseTo(1);
    expect(saved.isActive).toBe(true);
    expect(await prisma.memoryDerivation.findMany()).toEqual([
      expect.objectContaining({ derivedMemoryId: keeper.id, sourceMemoryId: dropped.id }),
    ]);
    expect((await maintenance.runForGame(sources[99].id)).deduped).toBe(0);
  });

  function clusterVector(index: number) {
    const v = vector();
    v[0] = Math.sqrt(0.8);
    v[index + 1] = Math.sqrt(0.2);
    return v;
  }

  it('三条通用经验固化为可检索策略；事务失败可重试，源记录和溯源一致', async () => {
    const sources = await games(100);
    const members: Awaited<ReturnType<typeof lesson>>[] = [];
    for (let i = 0; i < 3; i++)
      members.push(await lesson({ gameId: sources[i].id, embedding: clusterVector(i) }));
    llm.invoke.mockRejectedValueOnce(new Error('mock model unavailable'));
    await expect(maintenance.runForGame(sources[99].id)).rejects.toThrow('mock model unavailable');
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(3);
    await rejectDerivationWrites(() => maintenance.runForGame(sources[99].id));
    expect(await prisma.memory.count({ where: { type: 'strategy' } })).toBe(0);
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(3);
    expect((await maintenance.runForGame(sources[99].id)).consolidated).toBe(1);
    const strategy = await prisma.memory.findFirstOrThrow({ where: { type: 'strategy' } });
    expect(strategy).toMatchObject({
      source: 'refined',
      gameId: null,
      metadata: { consolidated: true, sourceCount: 3 },
    });
    expect(strategy.embeddingDimension).toBe(2048);
    expect(strategy.importance).toBeCloseTo(0.72);
    expect(await prisma.memory.count({ where: { type: 'lesson', isActive: true } })).toBe(0);
    const links = await prisma.memoryDerivation.findMany({
      where: { derivedMemoryId: strategy.id },
    });
    expect(new Set(links.map((link) => link.sourceMemoryId))).toEqual(
      new Set(members.map((m) => m.id)),
    );
    expect(
      await memories.retrieveActiveMemories(agentId, 'test', {
        types: ['persona', 'strategy'],
        trackRetrieval: false,
      }),
    ).toEqual([expect.objectContaining({ id: strategy.id, content: '先核对证据再表达判断' })]);
    const calls = llm.invoke.mock.calls.length;
    expect((await maintenance.runForGame(sources[99].id)).consolidated).toBe(0);
    expect(llm.invoke).toHaveBeenCalledTimes(calls);
  });

  it('只有两条通用经验时不固化，也不调用模型', async () => {
    const sources = await games(100);
    await lesson({ embedding: clusterVector(0) });
    await lesson({ embedding: clusterVector(1) });
    expect((await maintenance.runForGame(sources[99].id)).consolidated).toBe(0);
    expect(llm.invoke).not.toHaveBeenCalled();
  });

  it('固化后向量失败的策略仍可直读且溯源完整，回填不消耗策略 embedding', async () => {
    const sources = await games(100);
    for (let i = 0; i < 3; i++) await lesson({ embedding: clusterVector(i) });
    embedding.embedTexts.mockRejectedValueOnce(new Error('mock embedding unavailable'));
    expect((await maintenance.runForGame(sources[99].id)).consolidated).toBe(1);
    const strategy = await prisma.memory.findFirstOrThrow({ where: { type: 'strategy' } });
    expect(strategy.embeddingModel).toBeNull();
    expect(await prisma.memoryDerivation.count()).toBe(3);
    expect(
      (
        await memories.retrieveActiveMemories(agentId, 'test', {
          types: ['strategy'],
          trackRetrieval: false,
        })
      )[0].id,
    ).toBe(strategy.id);
    const embeddingCalls = embedding.embedTexts.mock.calls.length;
    expect(await memories.backfillEmbeddings()).toBe(0);
    expect(embedding.embedTexts).toHaveBeenCalledTimes(embeddingCalls);
    expect(
      (await prisma.memory.findUniqueOrThrow({ where: { id: strategy.id } })).embeddingDimension,
    ).toBeNull();
  });

  it.each([true, false])(
    '平台评分采用后刷新复盘与反思，事务保留历史元数据及旧记忆（写经验=%s）',
    async (writeLearning) => {
      const g = await game();
      const playerId = g.players[0].id;
      const event = await scoredVote(g);
      await prisma.event.update({
        where: { id: event.id },
        data: { content: { voterSeatNo: 1, targetSeatNo: 2 } },
      });
      const runId = `reflection-${randomUUID()}`;
      await prisma.evaluationRun.create({
        data: {
          id: runId,
          gameId: g.id,
          status: 'complete',
          expectedEventIds: [event.id],
          definition: { id: '隔离测试评分定义' },
        },
      });
      await prisma.decisionJudgment.update({
        where: { eventId: event.id },
        data: { evaluationRunId: runId },
      });
      await prisma.gameSummary.create({
        data: {
          gameId: g.id,
          totalDays: 1,
          winnerFaction: 'villager',
          villagerAliveCount: 1,
          werewolfAliveCount: 0,
          totalSpeechCount: 0,
          narrative: JSON.stringify({ narrative: '旧复盘', patterns: [], turningPoints: [] }),
        },
      });
      await prisma.agentPerformance.create({
        data: {
          gameId: g.id,
          playerId,
          role: 'villager',
          faction: 'villager',
          survivalDays: 1,
          isWinner: true,
          reflectionGenerated: true,
          metadata: { historical: { preserved: true }, reflectionEvaluationRunId: 'old-run' },
        },
      });
      const oldMemory = await prisma.memory.create({
        data: {
          agentId,
          gameId: g.id,
          label: 'test',
          type: 'reflection',
          source: 'auto',
          title: '旧反思',
          content: '旧内容',
        },
      });
      const prompts = {
        render: jest.fn().mockResolvedValue({ text: '隔离测试', name: 'test', version: null }),
      } as unknown as PromptService;
      const reviewOutput = { narrative: '新复盘', patterns: [], turningPoints: [] };
      const reviewLlm = { invoke: jest.fn().mockResolvedValue({ output: reviewOutput }) };
      const review = new GameReviewService(
        prisma,
        prompts,
        reviewLlm as unknown as StructuredLlmService,
      );
      const reflectionOutput = { summary: '新反思', lessons: [], playerModels: [] };
      const reflectionLlm = { invoke: jest.fn().mockResolvedValue({ output: reflectionOutput }) };
      const reflection = new ReflectionService(
        prisma,
        prompts,
        reflectionLlm as unknown as StructuredLlmService,
        memories,
        review,
      );

      expect(await review.loadReview(g.id)).toBeNull();
      await review.reviewGame(g.id);
      expect(
        JSON.parse(
          (await prisma.gameSummary.findUniqueOrThrow({ where: { gameId: g.id } })).narrative!,
        ),
      ).toEqual({ ...reviewOutput, evaluationRunId: runId });
      expect(await reflection.reflect(g.id, playerId, false, writeLearning)).toBe(
        writeLearning ? 1 : 0,
      );
      const performance = await prisma.agentPerformance.findUniqueOrThrow({
        where: { gameId_playerId: { gameId: g.id, playerId } },
      });
      expect(performance.metadata).toMatchObject({
        historical: { preserved: true },
        reflectionEvaluationRunId: runId,
        ...(!writeLearning ? { experimentReflection: reflectionOutput } : {}),
      });
      expect(
        (await prisma.memory.findUniqueOrThrow({ where: { id: oldMemory.id } })).isActive,
      ).toBe(!writeLearning);
      expect(await reflection.reflect(g.id, playerId, false, writeLearning)).toBe(0);
      expect(reflectionLlm.invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { role: 'seer', scenario: 'any', conditions: [] },
    { role: 'any', scenario: 'vote', conditions: [] },
    { role: 'any', scenario: 'any', conditions: ['public_discussion'] },
    { role: 'any', scenario: 'any' },
  ])('固化不丢失适用条件：%j', async (metadata) => {
    const sources = await games(100);
    for (let i = 0; i < 3; i++) await lesson({ metadata, embedding: clusterVector(i) });
    expect((await maintenance.runForGame(sources[99].id)).consolidated).toBe(0);
    expect(llm.invoke).not.toHaveBeenCalled();
    expect(await prisma.memory.count({ where: { isActive: true } })).toBe(3);
  });

  it('学习排名仅消费当前版本 reward 和基线，保留旧分、过期回填及实验数据', async () => {
    const ordinary = await game();
    const experiment = await game(2, true);
    const old = await lesson();
    const current = await lesson();
    const stale = await lesson();
    const experimental = await lesson();
    let sequence = 0;
    for (const [memory, g, version, score, reward] of [
      [old, ordinary, EVALUATION_VERSION - 1, 100, 100],
      [current, ordinary, EVALUATION_VERSION, 20, 20],
      [stale, ordinary, EVALUATION_VERSION, 20, 99],
      [experimental, experiment, EVALUATION_VERSION, 100, 100],
    ] as const) {
      const event = await prisma.event.create({
        data: {
          gameId: g.id,
          actorId: g.players[0].id,
          sequence: ++sequence,
          day: 1,
          phase: 'vote',
          actionType: 'vote',
          content: {},
        },
      });
      await prisma.decisionJudgment.create({
        data: {
          gameId: g.id,
          playerId: g.players[0].id,
          eventId: event.id,
          actionType: 'vote',
          day: 1,
          score,
          verdict: 'fair',
          modelName: 'mock',
          evaluationVersion: version,
        },
      });
      await prisma.memoryUsage.create({
        data: {
          gameId: g.id,
          playerId: g.players[0].id,
          memoryId: memory.id,
          eventId: event.id,
          scenario: 'vote',
          actionType: 'vote',
          day: 1,
          triggerMatched: true,
          rewardScore: reward,
        },
      });
    }
    const frozen = await memories.captureExperimentMemories([agentId]);
    expect(frozen.find((m) => m.id === current.id)?.rank).toBeCloseTo(0);
    for (const memory of [old, stale, experimental])
      expect(frozen.find((m) => m.id === memory.id)?.rank).toBeCloseTo(80);
    const ranked = await memories.retrieveExperience({
      agentId,
      label: 'test',
      opponentAgentIds: [],
      query: '经验',
      role: 'villager',
      scenario: 'vote',
      lessonLimit: 4,
    });
    expect(ranked.lessons).toHaveLength(4);
    expect(ranked.lessons.at(-1)?.id).toBe(current.id);
    expect(await prisma.memoryUsage.count()).toBe(4);
    expect(await prisma.decisionJudgment.count()).toBe(4);
  });

  it.each([false, true])(
    '当前版本团队狼刀 reward 仍可经提刀事件参与学习，旧 usage=%s',
    async (legacy) => {
      const g = await game();
      const memory = await lesson();
      const proposal = await prisma.event.create({
        data: {
          gameId: g.id,
          actorId: g.players[0].id,
          sequence: 1,
          day: 1,
          phase: 'night',
          actionType: 'wolf_kill',
          content: {},
        },
      });
      const kill = await prisma.event.create({
        data: {
          gameId: g.id,
          sequence: 2,
          day: 1,
          phase: 'night',
          actionType: 'wolf_kill',
          content: { proposalEventIds: [proposal.id] },
        },
      });
      await prisma.teamJudgment.create({
        data: {
          eventId: kill.id,
          gameId: g.id,
          faction: 'werewolf',
          actionType: 'wolf_kill',
          score: 80,
          verdict: 'good',
          reasoning: 'mock',
          modelName: 'mock',
          evaluationVersion: EVALUATION_VERSION,
        },
      });
      await prisma.memoryUsage.create({
        data: {
          memoryId: memory.id,
          gameId: g.id,
          playerId: g.players[0].id,
          eventId: legacy ? null : proposal.id,
          day: 1,
          actionType: 'wolf_kill',
          scenario: 'night_action',
          triggerMatched: true,
          rewardScore: 80,
        },
      });
      const eligible = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT u.id FROM memory_usages u WHERE true ${CURRENT_LEARNING_USAGE_FILTER}`;
      expect(eligible).toHaveLength(1);
      await prisma.teamJudgment.update({
        where: { eventId: kill.id },
        data: { evaluationVersion: EVALUATION_VERSION - 1 },
      });
      expect(
        await prisma.$queryRaw`SELECT u.id FROM memory_usages u WHERE true ${CURRENT_LEARNING_USAGE_FILTER}`,
      ).toEqual([]);
    },
  );

  it.each([
    { version: EVALUATION_VERSION, experiment: false, eligible: true },
    { version: EVALUATION_VERSION - 1, experiment: false, eligible: false },
    { version: EVALUATION_VERSION, experiment: true, eligible: false },
  ])(
    '旧 usage 唯一事件回填后按当前版本和普通局过滤：%j',
    async ({ version, experiment, eligible }) => {
      const g = await game(1, experiment);
      const memory = await lesson();
      await scoredVote(g, 1, version);
      const usage = await prisma.memoryUsage.create({
        data: {
          gameId: g.id,
          playerId: g.players[0].id,
          memoryId: memory.id,
          scenario: 'vote',
          actionType: 'vote',
          day: 1,
          triggerMatched: true,
          rewardScore: 20,
        },
      });
      const judge = new JudgeService(
        prisma,
        {} as PromptService,
        llm as unknown as StructuredLlmService,
        undefined as never,
      );
      await expect(judge.backfillRewards(g.id)).resolves.toBe(1);
      expect(await prisma.memoryUsage.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject(
        { eventId: null, rewardScore: 80 },
      );
      const hits = await prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT u.id FROM memory_usages u WHERE true ${CURRENT_LEARNING_USAGE_FILTER}`;
      expect(hits).toEqual(eligible ? [{ id: usage.id }] : []);
      const frozen = await memories.captureExperimentMemories([agentId]);
      expect(frozen.find((m) => m.id === memory.id)?.rank).toBeCloseTo(eligible ? 0 : 80);
      await expect(judge.backfillRewards(g.id)).resolves.toBe(1);
      expect(await prisma.memoryUsage.count()).toBe(1);
      expect(llm.invoke).not.toHaveBeenCalled();
    },
  );

  it('旧 usage 只有一个评分但有多个真实事件时，仍排除且回填清空旧 reward', async () => {
    const g = await game();
    const memory = await lesson();
    await scoredVote(g);
    await prisma.event.create({
      data: {
        gameId: g.id,
        actorId: g.players[0].id,
        sequence: 2,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        content: { target: null },
      },
    });
    const usage = await prisma.memoryUsage.create({
      data: {
        gameId: g.id,
        playerId: g.players[0].id,
        memoryId: memory.id,
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
        triggerMatched: true,
        rewardScore: 80,
      },
    });
    expect(
      await prisma.$queryRaw`SELECT u.id FROM memory_usages u WHERE true ${CURRENT_LEARNING_USAGE_FILTER}`,
    ).toEqual([]);
    const judge = new JudgeService(
      prisma,
      {} as PromptService,
      llm as unknown as StructuredLlmService,
      undefined as never,
    );
    await expect(judge.backfillRewards(g.id)).resolves.toBe(0);
    expect(await prisma.memoryUsage.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject({
      eventId: null,
      rewardScore: null,
    });
  });

  it.each([null, 20, 80])('攻略注入分组不依赖 reward 回填状态：%s', async (rewardScore) => {
    const g = await game();
    const injected = await scoredVote(g, 1);
    const nonInjected = await scoredVote(g, 2);
    const old = await scoredVote(g, 3, EVALUATION_VERSION - 1);
    const experiment = await game(2, true);
    const experimental = await scoredVote(experiment);
    for (let i = 0; i < 2; i++) {
      const chunk = await prisma.knowledgeChunk.create({
        data: {
          sourceFile: 'test.md',
          articleTitle: 'test',
          sectionTitle: 'test',
          role: 'any',
          scenario: 'any',
          trigger: 'test',
          action: 'test',
          content: 'test',
        },
      });
      for (const event of [injected, old, experimental]) {
        await prisma.knowledgeUsage.create({
          data: {
            chunkId: chunk.id,
            gameId: event.gameId,
            playerId: event.actorId!,
            eventId: event.id,
            scenario: 'vote',
            actionType: 'vote',
            day: 1,
            rewardScore,
          },
        });
      }
    }
    const rows = await loadKnowledgeScoredEvents(prisma);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { eventId: injected.id, score: 80, injected: true },
        { eventId: nonInjected.id, score: 80, injected: false },
      ]),
    );
  });

  it('固化策略与已晋升规律经真实检索进入下一局最终 system prompt', async () => {
    const sources = await games(100);
    for (let i = 0; i < 3; i++) {
      await lesson({ embedding: clusterVector(i) });
      await globalMemories.promotePatterns(sources[i].id, [pattern]);
    }
    await maintenance.runForGame(sources[99].id);
    const next = await game(101);
    const runtimeConfig = { get: jest.fn().mockReturnValue(false) } as unknown as ConfigService<
      Env,
      true
    >;
    const runtime = createAgentRuntime(
      runtimeConfig,
      prisma,
      memories,
      globalMemories,
      {} as KnowledgeService,
      {
        loadRequiredSkill: jest.fn().mockResolvedValue({ content: 'mock skill' }),
      } as unknown as SkillLoaderService,
      {
        readPersonalJudgments: jest.fn().mockResolvedValue({
          recentSpeeches: [],
          olderSpeechesSummary: [],
          recentJudgments: [],
          olderJudgmentsSummary: [],
        }),
      } as unknown as SpeechSummarizerService,
      {} as LangfuseService,
      new PromptService(runtimeConfig),
    );

    const context = await runtime.prepareContextPublic({
      gameId: next.id,
      playerId: next.players[0].id,
      scenario: 'vote',
      actionType: 'vote',
      position: { day: 1, phase: 'vote', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
    });
    expect(context.systemPrompt).toContain('固化策略');
    expect(context.systemPrompt).toContain('先核对证据再表达判断');
    expect(context.systemPrompt).toContain(pattern.content);
  });

  it('Redis flow 等待玩家反思后触发维护，实际 worker 写入衰减结果', async () => {
    const sources = await games(50);
    const g = sources[49];
    const memory = await lesson();
    await withLearningTestQueues(
      async ({
        maintenanceQueue,
        reflectionQueue,
        maintenanceEvents,
        reflectionEvents,
        flow,
        connection,
        prefix,
        workers,
      }) => {
        const realMaintenance = new MemoryMaintenanceService(
          maintenanceQueue,
          prisma,
          embedding as unknown as EmbeddingService,
          memories,
          {} as PromptService,
          llm as unknown as StructuredLlmService,
        );
        const maintenanceHost = new MaintenanceWorkerService(realMaintenance);
        const queueService = new ReflectionQueueService(
          reflectionQueue,
          connection as unknown as RedisService,
          flow,
        );
        const reflect = jest.fn(async () => {
          expect(await maintenanceQueue.getJob('maintenance_' + g.id)).toBeUndefined();
        });
        const reflectionHost = new ReflectionWorkerService(
          prisma,
          {} as JudgeService,
          {} as GameReviewService,
          { reflect } as unknown as ReflectionService,
          globalMemories,
          realMaintenance,
          queueService,
        );
        workers.push(
          new Worker(MEMORY_MAINTENANCE_QUEUE, (job) => maintenanceHost.process(job), {
            connection,
            prefix,
            concurrency: 1,
          }),
        );
        workers.push(
          new Worker(
            REFLECT_QUEUE_NAME,
            (job) => reflectionHost.process(job as Job<ReflectJobData>),
            { connection, prefix, concurrency: 2 },
          ),
        );
        await queueService.enqueuePlayers(g.id, [g.players[0].id]);
        const complete = await reflectionQueue.getJob(buildReflectionCompleteJobId(g.id));
        await complete!.waitUntilFinished(reflectionEvents, 5000);
        const job = await maintenanceQueue.getJob('maintenance_' + g.id);
        await job!.waitUntilFinished(maintenanceEvents, 5000);
        expect(reflect).toHaveBeenCalledTimes(1);
        expect(
          (await prisma.memory.findUniqueOrThrow({ where: { id: memory.id } })).importance,
        ).toBeCloseTo(0.72);
        await realMaintenance.enqueueForGame(g.id);
        expect(await maintenanceQueue.getJobCounts('completed')).toMatchObject({ completed: 1 });
      },
    );
  });

  it('真实维护 worker 自动重试两次，失败任务可由原入口恢复', async () => {
    const sources = await games(50);
    const g = sources[49];
    await lesson();
    await withLearningTestQueues(
      async ({ maintenanceQueue, maintenanceEvents, connection, prefix, workers }) => {
        const realMaintenance = new MemoryMaintenanceService(
          maintenanceQueue,
          prisma,
          embedding as unknown as EmbeddingService,
          memories,
          {} as PromptService,
          llm as unknown as StructuredLlmService,
        );
        const run = realMaintenance.runForGame.bind(realMaintenance);
        const calls = jest
          .spyOn(realMaintenance, 'runForGame')
          .mockRejectedValueOnce(new Error('test database unavailable'))
          .mockRejectedValueOnce(new Error('test database unavailable'))
          .mockImplementation(run);
        const host = new MaintenanceWorkerService(realMaintenance);
        workers.push(
          new Worker(MEMORY_MAINTENANCE_QUEUE, (job) => host.process(job), {
            connection,
            prefix,
            concurrency: 1,
          }),
        );
        // 测试任务缩短退避等待；生产的重试参数保持不变。
        const job = await maintenanceQueue.add(
          'run',
          { gameId: g.id },
          {
            ...MAINTENANCE_JOB_OPTIONS,
            jobId: 'maintenance_' + g.id,
            backoff: { type: 'fixed', delay: 10 },
          },
        );
        await expect(job.waitUntilFinished(maintenanceEvents, 5000)).rejects.toThrow(
          'test database unavailable',
        );
        expect(calls).toHaveBeenCalledTimes(2);
        expect(await job.getState()).toBe('failed');
        await realMaintenance.enqueueForGame(g.id);
        await job.waitUntilFinished(maintenanceEvents, 5000);
        expect(calls).toHaveBeenCalledTimes(3);
        expect(await job.getState()).toBe('completed');
      },
    );
  });
});
