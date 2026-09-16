import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Queue, QueueEvents, Worker } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
import type { Event } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { PromptService } from '../src/observability/prompt.service';
import type { StructuredLlmService } from '../src/observability/structured-llm.service';
import { traceIdentity } from '../src/observability/action-source';
import {
  EvaluationProjectionService,
  type EvaluatedResult,
  type AdoptScoresInput,
  type EvaluationDefinition,
} from '../src/evaluation/evaluation-projection.service';
import {
  LangfuseScoresService,
  type IngestionEvent,
  type PlatformScore,
  type ScoreReference,
} from '../src/evaluation/langfuse-scores.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { withLearningTestQueues } from './helpers/learning-test-queues';
import { JudgeService } from '../src/evaluation/judge.service';
import { JudgeWorkerService } from '../src/evaluation/judge.worker';
import { JUDGE_JOB_NAMES, JUDGE_QUEUE_NAME } from '../src/evaluation/judge-queue.service';
import { ReflectionWorkerService } from '../src/reflection/reflection.worker';
import {
  EvaluationDeliveryService,
  EVALUATION_DELIVERY_QUEUE,
} from '../src/evaluation/evaluation-delivery.service';
import { EvaluationDeliveryWorker } from '../src/evaluation/evaluation-delivery.worker';
import { REFLECT_JOB_NAMES, REFLECT_QUEUE_NAME } from '../src/reflection/reflection-queue.service';

/** 平台桩只实现 HTTP 协议及结果存储；PG 事务、完整度和采用逻辑均运行正式代码。 */
class ScoresPlatform {
  readonly scores = new Map<string, PlatformScore>();
  readonly batches: IngestionEvent[][] = [];
  projectId = 'test-project';
  offline = false;
  invisible = false;
  loseNextWriteResponse = false;
  qualityOnly = false;
  readsBeforeFailure: number | null = null;
  private readonly configurations: Array<Record<string, unknown>> = [];

  readonly fetch = jest.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (this.offline) throw new Error('平台暂时断开');
      const url = new URL(String(input));
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      if (url.pathname === '/api/public/projects')
        return this.response({ data: [{ id: this.projectId, name: '隔离平台桩' }] });
      if (url.pathname === '/api/public/score-configs') {
        if (body) {
          const config = { id: randomUUID(), ...body };
          this.configurations.push(config);
          return this.response(config);
        }
        return this.response({ data: this.configurations, meta: { totalPages: 1 } });
      }
      if (url.pathname === '/api/public/ingestion') {
        const batch = body!.batch as IngestionEvent[];
        this.batches.push(batch);
        for (const event of batch) {
          if (event.type !== 'score-create') continue;
          const score = event.body;
          if (this.qualityOnly && score.dataType === 'CATEGORICAL') continue;
          const saved: PlatformScore = {
            id: String(score.id),
            name: String(score.name),
            timestamp: event.timestamp,
            projectId: this.projectId,
            value: score.value as number | string,
            dataType: String(score.dataType),
            source: 'API',
            configId: String(score.configId),
            comment: String(score.comment),
            metadata: score.metadata as Record<string, unknown>,
            subject: {
              kind: 'observation',
              id: String(score.observationId),
              traceId: String(score.traceId),
            },
          };
          this.scores.set([saved.id, saved.name, saved.timestamp.slice(0, 10)].join('/'), saved);
        }
        if (batch.some((event) => event.type === 'score-create') && this.loseNextWriteResponse) {
          this.loseNextWriteResponse = false;
          throw new Error('平台已保存，但响应丢失');
        }
        return this.response({ successes: [], errors: [] });
      }
      if (url.pathname === '/api/public/v3/scores') {
        if (this.readsBeforeFailure === 0) throw new Error('采用回读暂时失败');
        if (this.readsBeforeFailure !== null) this.readsBeforeFailure--;
        const ids = new Set(url.searchParams.get('id')?.split(','));
        return this.response({
          data: this.invisible
            ? []
            : [...this.scores.values()].filter((score) => ids.has(score.id)),
          meta: {},
        });
      }
      throw new Error('测试未声明的网络路径：' + url.pathname);
    },
  );

  private response(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  scoreWrites(): IngestionEvent[] {
    return this.batches.flat().filter((event) => event.type === 'score-create');
  }
}

describe('Langfuse 评分投影：隔离 PostgreSQL 与 HTTP 平台桩', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let platform: ScoresPlatform;
  let service: EvaluationProjectionService;
  let rulesetId: string;
  let fetchSpy: jest.SpyInstance;
  const promptSnapshot = {
    judge: { text: '冻结裁判定义', name: 'judge', version: 3, source: 'langfuse' },
  };
  const prompts = { captureSnapshot: jest.fn(async () => structuredClone(promptSnapshot)) };
  const llm = {
    captureConfiguration: jest.fn(() => ({
      modelName: 'judge-test',
      baseUrl: 'http://model.invalid/v1',
    })),
  };
  const result = (score = 80): EvaluatedResult => ({
    score,
    verdict: score >= 70 ? 'good' : 'fair',
    reasoning: '依据授权时点的证据判分',
    modelName: 'judge-test',
    input: { visibleEvents: ['已授权发言'], decisionAt: 1 },
  });

  function processServices(overrides: Record<string, string> = {}): EvaluationProjectionService {
    const settings: Record<string, string> = {
      LANGFUSE_HOST: 'http://langfuse.invalid',
      LANGFUSE_PUBLIC_KEY: 'test-public',
      LANGFUSE_SECRET_KEY: 'test-secret',
      ...overrides,
    };
    const scores = new LangfuseScoresService({
      get: (key: string) => settings[key],
    } as unknown as ConfigService<Env, true>);
    return new EvaluationProjectionService(
      prisma,
      prompts as unknown as PromptService,
      llm as unknown as StructuredLlmService,
      scores,
    );
  }

  it.each(['domain-evaluator', 'committed-action'])(
    'Scores 成功但 %s 被拒绝后，恢复必须先补齐正文再清理暂存',
    async (rejectedName) => {
      const { game, events } = await fixture(1);
      const accepted = new Map<string, Record<string, unknown>>();
      let reject = true;
      fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const response = await platform.fetch(input, init);
        if (!String(input).endsWith('/api/public/ingestion')) return response;
        const batch = JSON.parse(String(init?.body)).batch as IngestionEvent[];
        const errors: Array<{ id: string; status: number }> = [];
        for (const event of batch) {
          if (event.type === 'score-create') continue;
          if (reject && event.body.name === rejectedName && event.body.output) {
            errors.push({ id: event.id, status: 500 });
          } else {
            const id = String(event.body.id);
            accepted.set(id, { ...accepted.get(id), ...event.body });
          }
        }
        return errors.length
          ? new Response(JSON.stringify({ successes: [], errors }), { status: 207 })
          : response;
      });
      const runId = 'partial-observation';
      const compute = jest.fn(async () => result(88));
      await service.begin(game.id, runId);
      await service.evaluate(game.id, events[0].id, runId, compute);
      await expect(service.deliverPending(runId)).rejects.toThrow('拒绝');
      const deliveredScores = structuredClone([...platform.scores.values()]);
      expect(deliveredScores).toHaveLength(2);
      // 模拟进程恢复且平台仍拒绝正文，不能靠可见的 Scores 误判交付成功。
      service = processServices();
      await service.evaluate(game.id, events[0].id, runId, compute);
      await expect(service.deliverPending(runId)).rejects.toThrow('拒绝');
      const pending = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(pending.deliveredEventIds).toEqual([]);
      expect(pending.pendingResults).toHaveProperty(events[0].id + '.result.score', 88);
      await service.complete(game.id, runId);
      reject = false;
      await service.evaluate(game.id, events[0].id, runId, compute);
      await service.deliverPending(runId);
      await service.complete(game.id, runId);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(platform.scoreWrites()).toHaveLength(6);
      expect([...platform.scores.values()]).toEqual(deliveredScores);
      const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run).toMatchObject({ status: 'complete', pendingResults: {} });
      const final = accepted.get(traceIdentity('judge-target', runId, events[0].id));
      expect(final).toHaveProperty('output.score', 88);
      expect(final).toHaveProperty('input.visibleEvents', ['已授权发言']);
      expect([...accepted.values()]).toContainEqual(
        expect.objectContaining({
          name: 'committed-action',
          output: events[0].content,
        }),
      );
    },
  );

  it('凭证改绑项目后不能把冻结运行的输入和结果上传到另一个项目', async () => {
    const { game, events } = await fixture(2);
    await service.begin(game.id, 'project-frozen');
    await service.evaluate(game.id, events[0].id, 'project-frozen', async () => result());
    await service.deliverPending('project-frozen');
    const written = platform.batches.length;
    platform.projectId = 'foreign-project';
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[1].id, 'project-frozen', compute);
    await service.complete(game.id, 'project-frozen');
    await expect(service.deliverPending('project-frozen')).rejects.toThrow('项目');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.batches).toHaveLength(written);
  });

  it('主动重评保留旧运行未上报结果；交付后清理且迟到任务不能复活', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'abandoned');
    await service.evaluate(game.id, events[0].id, 'abandoned', async () => result());
    const before = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'abandoned' } });
    expect(before.pendingResults).toHaveProperty(events[0].id + '.result');
    expect(before.definition).toHaveProperty('prompts');
    await service.begin(game.id, 'replacement');
    const old = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'abandoned' } });
    expect(old.status).toBe('superseded');
    expect(old.pendingResults).toHaveProperty(events[0].id + '.result');
    await service.deliverPending('abandoned');
    const compute = jest.fn(async () => result());
    await expect(service.evaluate(game.id, events[0].id, 'abandoned', compute)).rejects.toThrow(
      '迟到',
    );
    expect(compute).not.toHaveBeenCalled();
    expect(
      (await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'abandoned' } })).pendingResults,
    ).toEqual({});
  });

  it('模型失败后的已提交自动动作沿用逻辑行动 trace，不能把失败生成标为采用', async () => {
    const { game, events } = await fixture(1, false);
    const effectKey = game.id + '/automatic-vote';
    await prisma.event.update({ where: { id: events[0].id }, data: { effectKey } });
    await service.begin(game.id, 'automatic-action');
    await service.evaluate(game.id, events[0].id, 'automatic-action', async () => result());
    await service.complete(game.id, 'automatic-action');
    await service.deliverPending('automatic-action');
    const score = [...platform.scores.values()][0];
    expect(score.subject?.traceId).toBe(traceIdentity('action', effectKey));
    expect(score.metadata?.actionSource).toBeNull();
    const committed = platform.batches
      .flat()
      .find((entry) => entry.type === 'span-create' && entry.body.name === 'committed-action');
    expect(committed?.body.metadata).toMatchObject({ adoptedModelOutput: false });
  });

  it('并发登记晚到命中已完成运行时不能用精简引用覆盖平台完整定义', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'duplicate-begin');
    await service.evaluate(game.id, events[0].id, 'duplicate-begin', async () => result());
    await service.complete(game.id, 'duplicate-begin');
    const written = platform.batches.length;
    // 首次只读发生于竞争者登记前，事务内复核时另一请求已经完成采用。
    const staleRead = jest.spyOn(prisma.evaluationRun, 'findUnique').mockResolvedValueOnce(null);
    try {
      await service.begin(game.id, 'duplicate-begin');
    } finally {
      staleRead.mockRestore();
    }
    expect(platform.batches).toHaveLength(written);
  });

  it('交付完整 evaluator 正文，业务 observation ID 保持稳定', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'delivery-ids');
    await service.evaluate(game.id, events[0].id, 'delivery-ids', async () => result());
    await service.deliverPending('delivery-ids');
    const sent = platform.batches.flat();
    expect(new Set(sent.map((entry) => entry.id)).size).toBe(sent.length);
    const evaluator = sent.filter((entry) => entry.body.name === 'domain-evaluator');
    expect(evaluator).toHaveLength(1);
    expect(evaluator[0].body).toMatchObject({
      id: traceIdentity('judge-target', 'delivery-ids', events[0].id),
      input: result().input,
      output: { score: 80, verdict: 'good' },
    });
  });

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  }, 120_000);
  afterAll(async () => {
    fetchSpy?.mockRestore();
    await database?.close();
  });
  beforeEach(async () => {
    await database.reset();
    fetchSpy?.mockRestore();
    platform = new ScoresPlatform();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(platform.fetch);
    service = processServices();
    rulesetId = randomUUID();
    await prisma.ruleset.create({
      data: { id: rulesetId, name: '隔离评分测试', playerCount: 2, definition: {} },
    });
    jest.clearAllMocks();
  });

  async function fixture(count = 2, withSource = true) {
    const game = await prisma.game.create({
      data: {
        rulesetId,
        skillVersion: 'test',
        status: 'finished',
        endedAt: new Date(),
        players: {
          create: Array.from({ length: 2 }, (_, index) => ({
            seatNo: index + 1,
            role: 'villager',
            faction: 'villager',
            displayName: '测试玩家' + index,
            modelName: 'player-test',
            memoryLabelSnapshot: 'test',
            agent: {
              create: { name: randomUUID(), defaultModelName: 'player-test', memoryLabel: 'test' },
            },
          })),
        },
      },
      include: { players: { orderBy: { seatNo: 'asc' } } },
    });
    await prisma.gameSummary.create({
      data: {
        gameId: game.id,
        totalDays: 1,
        winnerFaction: 'villager',
        villagerAliveCount: 2,
        werewolfAliveCount: 0,
        totalSpeechCount: 0,
      },
    });
    await prisma.agentPerformance.createMany({
      data: game.players.map((player) => ({
        gameId: game.id,
        playerId: player.id,
        role: 'villager',
        faction: 'villager',
        survivalDays: 1,
        isWinner: true,
      })),
    });
    const events: Event[] = [];
    for (let index = 0; index < count; index++) {
      const actionKey = game.id + '/vote/' + index;
      events.push(
        await prisma.event.create({
          data: {
            gameId: game.id,
            actorId: game.players[index % 2].id,
            sequence: index + 1,
            day: 1,
            phase: 'vote',
            actionType: 'vote',
            content: { targetSeatNo: 2, voterSeatNo: index + 1 },
            ...(withSource
              ? {
                  effectKey: actionKey,
                  source: {
                    actionKey,
                    traceId: traceIdentity(actionKey),
                    attemptId: randomUUID(),
                    outputObservationId: randomUUID(),
                    startedAt: new Date().toISOString(),
                  },
                }
              : {}),
          },
        }),
      );
    }
    return { game, events };
  }

  async function oldProjection(
    event: Awaited<ReturnType<typeof fixture>>['events'][number],
    score = 30,
  ) {
    await prisma.decisionJudgment.create({
      data: {
        gameId: event.gameId,
        playerId: event.actorId!,
        eventId: event.id,
        actionType: event.actionType,
        day: 1,
        verdict: 'poor',
        score,
        reasoning: '旧版业务理由',
        modelName: 'old-judge',
        evaluationVersion: 3,
        evaluationRunId: 'historical-run',
        previousEvaluations: [{ evaluationRunId: 'older-run', score: 20 }],
      },
    });
  }

  async function withDeliveryQueue(
    task: (
      queue: Queue<{ runId: string }>,
      events: QueueEvents,
      start: () => Worker,
    ) => Promise<void>,
  ) {
    await withLearningTestQueues(async ({ connection, prefix, workers }) => {
      const options = { connection, prefix };
      const queue = new Queue<{ runId: string }>(EVALUATION_DELIVERY_QUEUE, options);
      const events = new QueueEvents(EVALUATION_DELIVERY_QUEUE, options);
      const start = () => {
        const host = new EvaluationDeliveryWorker(service);
        const worker = new Worker(EVALUATION_DELIVERY_QUEUE, (job) => host.process(job), options);
        workers.push(worker);
        return worker;
      };
      try {
        await events.waitUntilReady();
        await task(queue, events, start);
      } finally {
        await Promise.all(workers.map((worker) => worker.close()));
        workers.length = 0;
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });
  }

  it('最终判分提交后子进程直接退出，重启扫描从数据库恢复真实队列交付', async () => {
    const { game, events } = await fixture(1);
    const runId = 'crash-before-enqueue';
    await service.begin(game.id, runId);
    const child = promisify(execFile)(
      process.execPath,
      [
        '--experimental-vm-modules',
        './node_modules/jest/bin/jest.js',
        '--config',
        './test/jest-langfuse-projection-integration.json',
        '--runInBand',
        '--testRegex',
        'evaluation-crash-child\\.ts$',
        '--runTestsByPath',
        './test/helpers/evaluation-crash-child.ts',
      ],
      {
        cwd: resolve(__dirname, '..'),
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          EVALUATION_TEST_DATABASE: database.connectionString,
          EVALUATION_TEST_GAME: game.id,
          EVALUATION_TEST_EVENT: events[0].id,
        },
      },
    );
    await expect(child).rejects.toMatchObject({ code: 73 });
    expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
      pendingResults: { [events[0].id]: { result: { score: 80 } } },
    });
    service = processServices();
    await service.complete(game.id, runId);
    await withDeliveryQueue(async (queue, queueEvents, start) => {
      expect(await queue.getJob(runId)).toBeUndefined();
      await new EvaluationDeliveryService(prisma, queue).dispatchPending();
      const job = await queue.getJob(runId);
      expect(job).toBeDefined();
      const completed = job!.waitUntilFinished(queueEvents, 5000);
      start();
      await completed;
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'complete',
        pendingResults: {},
        deliveredEventIds: [],
      });
      expect(platform.scores.size).toBe(2);
    });
  }, 40_000);

  it('Redis 接收任务但响应丢失，并发扫描仍只留下一个交付任务', async () => {
    const { game, events } = await fixture(1);
    const runId = 'redis-response-lost';
    await service.begin(game.id, runId);
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[0].id, runId, compute);
    await withDeliveryQueue(async (queue, queueEvents, start) => {
      const add = queue.add.bind(queue);
      const lost = jest.spyOn(queue, 'add').mockImplementationOnce(async (...args) => {
        await add(...args);
        throw new Error('Redis 已接收，响应丢失');
      });
      await new EvaluationDeliveryService(prisma, queue).dispatchPending();
      lost.mockRestore();
      await Promise.all([
        new EvaluationDeliveryService(prisma, queue).dispatchPending(),
        new EvaluationDeliveryService(prisma, queue).dispatchPending(),
      ]);
      expect(await queue.getWaitingCount()).toBe(1);
      const job = (await queue.getJob(runId))!;
      const completed = job.waitUntilFinished(queueEvents, 5000);
      start();
      await completed;
      // 上报先完成，业务仍能从本地采用。
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'pending',
        deliveredEventIds: [events[0].id],
      });
      await service.complete(game.id, runId);
      await service.evaluate(game.id, events[0].id, runId, compute);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(platform.scoreWrites()).toHaveLength(2);
    });
  });

  it('平台保存后响应丢失只让交付任务失败；业务先完成，扫描重试后清理载荷', async () => {
    const { game, events } = await fixture(1);
    const runId = 'delivery-response-lost';
    await service.begin(game.id, runId);
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[0].id, runId, compute);
    platform.loseNextWriteResponse = true;
    await withDeliveryQueue(async (queue, queueEvents, start) => {
      const scanner = new EvaluationDeliveryService(prisma, queue);
      await scanner.dispatchPending();
      let job = (await queue.getJob(runId))!;
      const failed = expect(job.waitUntilFinished(queueEvents, 5000)).rejects.toThrow('响应丢失');
      const worker = start();
      await failed;
      await worker.pause();
      await service.complete(game.id, runId);
      const before = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(before.status).toBe('complete');
      expect(before.pendingResults).toHaveProperty(events[0].id + '.result');
      job = (await queue.getJob(runId))!;
      await scanner.dispatchPending();
      expect(await job.getState()).toBe('failed');
      const now = jest.spyOn(Date, 'now').mockReturnValue(job.finishedOn! + 60_001);
      try {
        await scanner.dispatchPending();
      } finally {
        now.mockRestore();
      }
      const completed = job.waitUntilFinished(queueEvents, 5000);
      worker.resume();
      await completed;
      await service.evaluate(game.id, events[0].id, runId, compute);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(platform.scoreWrites()).toHaveLength(4);
      expect(platform.scores.size).toBe(2);
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'complete',
        pendingResults: {},
        deliveredEventIds: [],
      });
    });
  });

  it('交付等待回包时两个 completion 并发，只采用一次且未确认载荷不丢失', async () => {
    const { game, events } = await fixture(1);
    const runId = 'concurrent-completion-delivery';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await platform.fetch(input, init);
      if (String(init?.body).includes('score-create')) {
        entered();
        await gate;
      }
      return response;
    });
    const delivery = service.deliverPending(runId);
    await waiting;
    try {
      await Promise.all([service.complete(game.id, runId), service.complete(game.id, runId)]);
      expect(await prisma.decisionJudgment.count()).toBe(1);
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'complete',
        definition: { projectId: 'test-project' },
        pendingResults: { [events[0].id]: { result: { score: 80 } } },
      });
    } finally {
      release();
      await delivery;
    }
    const completed = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(completed.pendingResults).toEqual({});
    expect(completed.definition).not.toHaveProperty('prompts');
    await service.deliverPending(runId);
    expect(platform.scoreWrites()).toHaveLength(2);
  });

  it('MVP 最后写入失败时，评分、奖励、玩家分和完成状态一起回滚', async () => {
    const { game, events } = await fixture(1);
    const runId = 'atomic-business';
    await oldProjection(events[0]);
    const memory = await prisma.memory.create({
      data: {
        agentId: game.players[0].agentId,
        label: 'test',
        type: 'lesson',
        title: '测试经验',
        content: '依据事实投票',
      },
    });
    const usage = await prisma.memoryUsage.create({
      data: {
        memoryId: memory.id,
        gameId: game.id,
        playerId: game.players[0].id,
        eventId: events[0].id,
        scenario: 'vote',
        actionType: 'vote',
        day: 1,
        rewardScore: 12,
      },
    });
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    await prisma.$executeRawUnsafe(
      'ALTER TABLE game_summaries ADD CONSTRAINT test_mvp_commit CHECK (mvp_player_id IS NULL)',
    );
    try {
      await expect(service.complete(game.id, runId)).rejects.toThrow();
      expect(
        await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
      ).toMatchObject({ score: 30 });
      expect(await prisma.memoryUsage.findUnique({ where: { id: usage.id } })).toMatchObject({
        rewardScore: 12,
      });
      expect((await prisma.agentPerformance.findMany()).every((row) => row.score === null)).toBe(
        true,
      );
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'pending',
      });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE game_summaries DROP CONSTRAINT test_mvp_commit');
    }
    await service.complete(game.id, runId);
    expect(await prisma.memoryUsage.findUnique({ where: { id: usage.id } })).toMatchObject({
      rewardScore: 80,
    });
    expect(
      await prisma.agentPerformance.findFirst({ where: { playerId: game.players[0].id } }),
    ).toMatchObject({ score: 80 });
    expect(await prisma.gameSummary.findUnique({ where: { gameId: game.id } })).toMatchObject({
      mvpPlayerId: game.players[0].id,
    });
    expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
      status: 'complete',
    });
  });

  it('并发重复交付使用同一平台绑定和 Score 身份，完成后不留下载荷', async () => {
    const { game, events } = await fixture(1);
    const runId = 'duplicate-delivery';
    await service.begin(game.id, runId);
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[0].id, runId, compute);
    await service.complete(game.id, runId);
    await Promise.all([service.deliverPending(runId), service.deliverPending(runId)]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scores.size).toBe(2);
    expect(platform.scoreWrites().length).toBeGreaterThanOrEqual(2);
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    const bound = run.definition as unknown as EvaluationDefinition;
    for (const score of platform.scores.values())
      expect(score.configId).toBe(
        bound.configurations![score.dataType === 'NUMERIC' ? 'quality' : 'verdict'].id,
      );
    expect(run.pendingResults).toEqual({});
    expect(run.definition).not.toHaveProperty('prompts');
  });

  it('未确认上报目标时更换 host 或公钥必须拒绝交付，业务采用仍可完成', async () => {
    const { game, events } = await fixture(1);
    const runId = 'destination-changed';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    const changes: Array<Record<string, string>> = [
      { LANGFUSE_HOST: 'http://foreign.invalid' },
      { LANGFUSE_PUBLIC_KEY: 'foreign-public' },
    ];
    for (const change of changes) {
      service = processServices(change);
      await expect(service.deliverPending(runId)).rejects.toThrow('上报目标已改变');
    }
    await service.complete(game.id, runId);
    expect(platform.fetch).not.toHaveBeenCalled();
    service = processServices();
    await service.deliverPending(runId);
    expect(platform.scores.size).toBe(2);
  });

  it('部分结果已上报、其余只在本地时仍能完整采用；只保留未上报结果', async () => {
    const { game, events } = await fixture(2);
    const runId = 'partial-delivery';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    await service.deliverPending(runId);
    await service.evaluate(game.id, events[1].id, runId, async () => result());
    platform.offline = true;
    await service.complete(game.id, runId);
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(Object.keys(run.pendingResults!)).toEqual([events[1].id]);
    expect(run.deliveredEventIds).toEqual([]);
    expect(run.definition).toHaveProperty('prompts');
    platform.offline = false;
    await service.deliverPending(runId);
    expect(platform.scoreWrites()).toHaveLength(4);
    expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
      pendingResults: {},
    });
  });

  it('平台完全离线也能登记、判分和采用；已采用的未上报结果仍持久保留', async () => {
    const { game, events } = await fixture(1);
    platform.offline = true;
    const compute = jest.fn(async () => result());
    const runId = 'offline-business';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, compute);
    await service.complete(game.id, runId);
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 80 });
    expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
      status: 'complete',
      pendingResults: { [events[0].id]: { result: { score: 80 } } },
    });
    expect(platform.fetch).not.toHaveBeenCalled();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('展示最新批次已保存判分的进度，整批采用完成前仍禁止消费评分', async () => {
    const { game, events } = await fixture(2);
    const judge = new JudgeService(prisma, prompts as never, llm as never, service);
    const runId = 'visible-progress';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 1,
      judgeableCount: 2,
      complete: false,
    });
    expect(await prisma.decisionJudgment.count()).toBe(0);
    await service.deliverPending(runId);
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 1,
      complete: false,
    });
    await service.evaluate(game.id, events[1].id, runId, async () => result());
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 2,
      complete: false,
    });
    await service.complete(game.id, runId);
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 2,
      complete: true,
    });
    await service.deliverPending(runId);
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 2,
      complete: true,
    });
    await service.begin(game.id, 'new-progress');
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 0,
      complete: false,
    });
    await prisma.evaluationRun.update({
      where: { id: 'new-progress' },
      data: {
        pendingResults: {
          [events[0].id]: { token: 'running', leaseUntil: new Date().toISOString() },
          unrelated: {
            result: { score: 80, verdict: 'good', reasoning: '无关目标', modelName: 'script' },
          },
        },
      },
    });
    expect(await judge.getEvaluationProgress(game.id)).toMatchObject({
      judgedCount: 0,
      complete: false,
    });
  });

  it('平台接收后即结束交付；评分不可见也能采用本地结果且不重新判分', async () => {
    const { game, events } = await fixture(2);
    const runId = 'asynchronous-scores';
    await service.begin(game.id, runId);
    platform.invisible = true;
    const compute = jest.fn(async () => result());
    for (const event of events) await service.evaluate(game.id, event.id, runId, compute);
    await service.deliverPending(runId);
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.deliveredEventIds.toSorted()).toEqual(events.map((event) => event.id).toSorted());
    expect(
      platform.fetch.mock.calls.filter(([url]) => String(url).includes('/v3/scores')),
    ).toHaveLength(0);
    expect(await prisma.decisionJudgment.count()).toBe(0);
    service = processServices();
    platform.offline = true;
    await service.complete(game.id, runId);
    const judgments = await prisma.decisionJudgment.findMany();
    expect(judgments).toHaveLength(2);
    expect(judgments.every((row) => row.score === 80 && row.modelName === 'judge-test')).toBe(true);
    expect(judgments.every((row) => !JSON.stringify(row.source).includes('visibleEvents'))).toBe(
      true,
    );
    expect(
      platform.fetch.mock.calls.filter(([url]) => String(url).includes('/v3/scores')),
    ).toHaveLength(0);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(platform.scoreWrites()).toHaveLength(4);
  });

  it('自动采用不受平台评分改动影响；本地最终结果缺失或损坏时不从平台代填', async () => {
    const { game, events } = await fixture(1);
    const runId = 'local-authority';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result(80));
    await service.deliverPending(runId);
    for (const score of platform.scores.values())
      if (score.dataType === 'NUMERIC') score.value = 10;
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    await prisma.evaluationRun.update({ where: { id: runId }, data: { pendingResults: {} } });
    await expect(service.complete(game.id, runId)).rejects.toThrow('缺少本地最终评分');
    expect(await prisma.decisionJudgment.count()).toBe(0);
    const entries = structuredClone(run.pendingResults) as Record<
      string,
      { result: { score: number } }
    >;
    entries[events[0].id].result.score = 101;
    await prisma.evaluationRun.update({ where: { id: runId }, data: { pendingResults: entries } });
    await expect(service.complete(game.id, runId)).rejects.toThrow('评分不符合');
    expect(await prisma.decisionJudgment.count()).toBe(0);
    await prisma.evaluationRun.update({
      where: { id: runId },
      data: { pendingResults: run.pendingResults! },
    });
    await service.complete(game.id, runId);
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({
      score: 80,
      source: { resultOrigin: 'local_evaluator' },
    });
  });

  it.each(['judge', 'reflection'])(
    '平台完全离线时，真实队列完成 %s 父任务及本地后续处理',
    async (parent) => {
      const { game, events } = await fixture(2);
      const runId = 'queue-local-results';
      platform.offline = true;
      await service.begin(game.id, runId);
      platform.invisible = true;
      platform.readsBeforeFailure = 0;
      const scriptModel = {
        invokeReflective: jest.fn(async () => ({ output: result(), modelName: 'judge-test' })),
      };
      const judge = new JudgeService(
        prisma,
        {
          render: async () => ({ text: '隔离脚本裁判', name: 'test', version: 1 }),
        } as unknown as PromptService,
        scriptModel as unknown as StructuredLlmService,
        service,
      );
      const judgeWorker = new JudgeWorkerService(judge);
      let reviewStarted = false;
      let playersEnqueued = false;
      const reflectionWorker = new ReflectionWorkerService(
        ...([
          prisma,
          judge,
          {
            reviewGame: async () => {
              expect(
                (await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } })).status,
              ).toBe('complete');
              expect(await prisma.decisionJudgment.count()).toBe(2);
              reviewStarted = true;
            },
            loadStoredReview: async () => null,
          },
          {},
          {},
          {},
          {
            enqueuePlayers: async () => {
              playersEnqueued = true;
            },
          },
        ] as unknown as ConstructorParameters<typeof ReflectionWorkerService>),
      );
      await withLearningTestQueues(async ({ connection, prefix, flow, reflectionEvents }) => {
        const options = { connection, prefix };
        const queue = new Queue(JUDGE_QUEUE_NAME, options);
        const queueEvents = new QueueEvents(JUDGE_QUEUE_NAME, options);
        const workers = [
          new Worker(JUDGE_QUEUE_NAME, (job) => judgeWorker.process(job), {
            ...options,
            concurrency: 2,
          }),
          new Worker(REFLECT_QUEUE_NAME, (job) => reflectionWorker.process(job), options),
        ];
        try {
          await queueEvents.waitUntilReady();
          const tree = await flow.add({
            name: parent === 'judge' ? JUDGE_JOB_NAMES.complete : REFLECT_JOB_NAMES.fanout,
            queueName: parent === 'judge' ? JUDGE_QUEUE_NAME : REFLECT_QUEUE_NAME,
            data:
              parent === 'judge'
                ? { gameId: game.id, runId }
                : { gameId: game.id, evaluationRunId: runId },
            opts: { attempts: 1 },
            children: events.map((event) => ({
              name: JUDGE_JOB_NAMES.decision,
              queueName: JUDGE_QUEUE_NAME,
              data: { gameId: game.id, runId, eventId: event.id },
              opts: { attempts: 1, failParentOnFailure: true },
            })),
          });
          await tree.job.waitUntilFinished(
            parent === 'judge' ? queueEvents : reflectionEvents,
            5000,
          );
          for (const child of tree.children ?? [])
            expect(await child.job.getState()).toBe('completed');
          expect(await queue.getJobCounts('failed', 'delayed')).toEqual({ failed: 0, delayed: 0 });
        } finally {
          await Promise.all(workers.map((worker) => worker.close()));
          await queueEvents.close();
          await queue.obliterate({ force: true });
          await queue.close();
        }
      });
      expect(scriptModel.invokeReflective).toHaveBeenCalledTimes(2);
      expect((await prisma.agentPerformance.findMany()).every((row) => row.score === 80)).toBe(
        true,
      );
      expect(
        (await prisma.gameSummary.findUniqueOrThrow({ where: { gameId: game.id } })).mvpPlayerId,
      ).not.toBeNull();
      expect(reviewStarted).toBe(parent === 'reflection');
      expect(playersEnqueued).toBe(parent === 'reflection');
      expect(
        platform.fetch.mock.calls.filter(([url]) => String(url).includes('/v3/scores')),
      ).toHaveLength(0);
    },
  );

  it('判分落库后上报响应丢失，进程重建重试只交付且始终保持原评分日期', async () => {
    const { game, events } = await fixture(1);
    const runId = 'response-lost';
    await service.begin(game.id, runId);
    const originalDate = new Date('2025-01-01T23:59:59.000Z');
    await prisma.evaluationRun.update({ where: { id: runId }, data: { createdAt: originalDate } });
    const compute = jest.fn(async () => result());
    platform.loseNextWriteResponse = true;
    await service.evaluate(game.id, events[0].id, runId, compute);
    await expect(service.deliverPending(runId)).rejects.toThrow('响应丢失');
    const pending = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(pending.pendingResults).toHaveProperty(events[0].id + '.result.score', 80);
    expect(await prisma.decisionJudgment.count()).toBe(0);
    service = processServices();
    // 响应丢失后只重交相同结果；平台索引仍不可见也不影响采用。
    platform.invisible = true;
    await service.deliverPending(runId);
    await service.evaluate(game.id, events[0].id, runId, compute);
    await service.evaluate(game.id, events[0].id, runId, compute);
    await service.complete(game.id, runId);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scoreWrites()).toHaveLength(4);
    expect(new Set(platform.scoreWrites().map((event) => event.timestamp))).toEqual(
      new Set([originalDate.toISOString()]),
    );
    expect(new Set(platform.scoreWrites().map((event) => event.body.id)).size).toBe(2);
    expect(platform.scores.size).toBe(2);
    expect(await prisma.event.count({ where: { gameId: game.id } })).toBe(1);
  });

  it('本地结果采用中数据库写入失败时整批回滚，恢复不重新判分', async () => {
    const { game, events } = await fixture(2);
    const runId = 'local-transaction';
    await Promise.all(events.map((event) => oldProjection(event)));
    await service.begin(game.id, runId);
    for (const [index, event] of events.entries())
      await service.evaluate(game.id, event.id, runId, async () => result(80 + index * 10));
    await prisma.$executeRawUnsafe(
      'ALTER TABLE decision_judgments ADD CONSTRAINT test_local_score_commit CHECK (score <> 90)',
    );
    try {
      await expect(service.complete(game.id, runId)).rejects.toThrow();
      expect((await prisma.decisionJudgment.findMany()).every((row) => row.score === 30)).toBe(
        true,
      );
      expect(await prisma.evaluationRun.findUnique({ where: { id: runId } })).toMatchObject({
        status: 'pending',
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE decision_judgments DROP CONSTRAINT test_local_score_commit',
      );
    }
    platform.offline = true;
    service = processServices();
    await service.complete(game.id, runId);
    expect((await prisma.decisionJudgment.findMany()).map((row) => row.score).toSorted()).toEqual([
      80, 90,
    ]);
  });

  it('只完成半批不会写入投影；整批采用后清空临时结果且不追加旧历史', async () => {
    const { game, events } = await fixture();
    await Promise.all(events.map((event) => oldProjection(event)));
    await service.begin(game.id, 'whole-batch');
    await service.evaluate(game.id, events[0].id, 'whole-batch', async () => result(80));
    await expect(service.complete(game.id, 'whole-batch')).rejects.toThrow('缺少本地最终评分');
    const partial = await prisma.decisionJudgment.findMany({ orderBy: { eventId: 'asc' } });
    expect(partial.map((entry) => [entry.score, entry.evaluationRunId, entry.source])).toEqual([
      [30, 'historical-run', null],
      [30, 'historical-run', null],
    ]);
    await service.evaluate(game.id, events[1].id, 'whole-batch', async () => result(90));
    await service.complete(game.id, 'whole-batch');
    await service.deliverPending('whole-batch');
    const adopted = await prisma.decisionJudgment.findMany();
    expect(adopted.map((entry) => entry.score).toSorted()).toEqual([80, 90]);
    expect(adopted.every((entry) => entry.evaluationRunId === 'whole-batch')).toBe(true);
    for (const entry of adopted)
      expect(entry.previousEvaluations).toEqual([{ evaluationRunId: 'older-run', score: 20 }]);
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'whole-batch' } });
    expect(run.status).toBe('complete');
    expect(run.pendingResults).toEqual({});
    expect(run.definition).not.toHaveProperty('prompts');
    expect(
      adopted.every(
        (entry) => entry.source && !JSON.stringify(entry.source).includes('visibleEvents'),
      ),
    ).toBe(true);
  });

  it('同一行动并发只允许一份判分，其他重试随后复用持久结果', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'concurrent');
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const compute = jest.fn(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result();
    });
    const first = service.evaluate(game.id, events[0].id, 'concurrent', compute);
    await enteredPromise;
    await expect(service.evaluate(game.id, events[0].id, 'concurrent', compute)).rejects.toThrow(
      '已有判分进行中',
    );
    release();
    await first;
    await service.evaluate(game.id, events[0].id, 'concurrent', compute);
    await service.deliverPending('concurrent');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scores.size).toBe(2);
  });

  it('上一进程遗留的判分租约由当前进程接管，恢复重试不被卡住', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'abandoned-lease');
    await prisma.evaluationRun.update({
      where: { id: 'abandoned-lease' },
      data: {
        pendingResults: {
          [events[0].id]: {
            token: 'dead-process',
            instanceId: 'dead-process',
            leaseUntil: new Date(Date.now() + 25 * 60_000).toISOString(),
          },
        },
      },
    });
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[0].id, 'abandoned-lease', compute);
    await service.deliverPending('abandoned-lease');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scores.size).toBe(2);
  });

  it('迟到的旧运行不能覆盖新运行已采用的结果，也不会再次判分', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'old-run');
    await prisma.evaluationRun.update({
      where: { id: 'old-run' },
      data: { createdAt: new Date('2025-01-01') },
    });
    await service.evaluate(game.id, events[0].id, 'old-run', async () => result(60));
    await service.begin(game.id, 'new-run');
    await service.evaluate(game.id, events[0].id, 'new-run', async () => result(90));
    await service.complete(game.id, 'new-run');
    await expect(service.complete(game.id, 'old-run')).rejects.toThrow('旧评分运行');
    const compute = jest.fn(async () => result(40));
    await expect(service.evaluate(game.id, events[0].id, 'old-run', compute)).rejects.toThrow(
      '旧评分运行',
    );
    expect(compute).not.toHaveBeenCalled();
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 90, evaluationRunId: 'new-run' });
    await service.deliverPending('old-run');
    await service.deliverPending('new-run');
    expect(platform.scores.size).toBe(4);
  });

  it('平台只可见一个维度时，自动评分仍采用本地完整结果', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'missing-verdict');
    platform.qualityOnly = true;
    const compute = jest.fn(async () => result());
    await service.evaluate(game.id, events[0].id, 'missing-verdict', compute);
    expect(await prisma.decisionJudgment.count()).toBe(0);
    await service.complete(game.id, 'missing-verdict');
    await service.deliverPending('missing-verdict');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scores.size).toBe(1);
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 80, verdict: 'good' });
  });

  it('真实 Event 和批次身份进入评分；不会把最终分数绑到最后一个模型调用', async () => {
    const { game, events } = await fixture();
    const batchKey = game.id + '/vote-batch';
    await prisma.effectBatchCommit.create({
      data: {
        batchKey,
        gameId: game.id,
        payloadHash: 'a'.repeat(64),
        outcomes: [],
        eventIds: events.map((event) => event.id),
      },
    });
    await service.begin(game.id, 'batch-source');
    await Promise.all(
      events.map((event) =>
        service.evaluate(game.id, event.id, 'batch-source', async () => result()),
      ),
    );
    await service.complete(game.id, 'batch-source');
    await service.deliverPending('batch-source');
    for (const event of events) {
      const actionSource = event.source as { traceId: string; outputObservationId: string };
      const scores = [...platform.scores.values()].filter(
        (score) => score.metadata?.eventId === event.id,
      );
      expect(scores).toHaveLength(2);
      for (const score of scores) {
        expect(score.subject).toMatchObject({ traceId: actionSource.traceId });
        expect(score.subject!.id).not.toBe(actionSource.outputObservationId);
        expect(score.metadata).toMatchObject({
          eventId: event.id,
          effectKey: event.effectKey,
          batchKey,
          actionSource: event.source,
        });
      }
    }
    expect(new Set([...platform.scores.values()].map((score) => score.subject!.id)).size).toBe(2);
  });

  it('零 Event 批次不创建虚构评分对象', async () => {
    const { game } = await fixture(0);
    await prisma.effectBatchCommit.create({
      data: {
        batchKey: game.id + '/empty',
        gameId: game.id,
        payloadHash: 'b'.repeat(64),
        outcomes: [{ outcome: 'no_output', actorId: game.players[0].id }],
        eventIds: [],
      },
    });
    await service.begin(game.id, 'empty');
    await service.complete(game.id, 'empty');
    expect(platform.scores.size).toBe(0);
    expect(await prisma.decisionJudgment.count()).toBe(0);
    expect(await prisma.evaluationRun.findUnique({ where: { id: 'empty' } })).toMatchObject({
      status: 'complete',
      expectedEventIds: [],
    });
  });

  it('历史评分和 Event 不冒造模型来源，显式新评估只关联已提交事实', async () => {
    const { game, events } = await fixture(1, false);
    await oldProjection(events[0]);
    await prisma.evaluationRun.create({
      data: {
        id: 'historical-run',
        gameId: game.id,
        status: 'complete',
        expectedEventIds: [events[0].id],
      },
    });
    platform.offline = true;
    await service.begin(game.id, 'historical-run');
    await service.complete(game.id, 'historical-run');
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 30, source: null });
    expect(platform.fetch).not.toHaveBeenCalled();
    platform.offline = false;
    await service.begin(game.id, 'explicit-new');
    await service.evaluate(game.id, events[0].id, 'explicit-new', async () => result());
    await service.complete(game.id, 'explicit-new');
    await service.deliverPending('explicit-new');
    const target = platform.batches
      .flat()
      .find((event) => event.type === 'trace-create' && event.body.name === 'committed-action');
    expect(target?.body.metadata).toMatchObject({ legacyGenerationUnavailable: true });
    expect(
      [...platform.scores.values()].every((score) => score.metadata?.actionSource === null),
    ).toBe(true);
    expect(await prisma.event.findUnique({ where: { id: events[0].id } })).toMatchObject({
      effectKey: null,
      source: null,
    });
  });

  it('已采用批次的下游重试在平台断开时仍保持本地幂等完成', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'adopted-offline');
    await service.evaluate(game.id, events[0].id, 'adopted-offline', async () => result());
    await service.complete(game.id, 'adopted-offline');
    platform.offline = true;
    await expect(service.complete(game.id, 'adopted-offline')).resolves.toBeUndefined();
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 80, evaluationRunId: 'adopted-offline' });
  });

  async function humanSelection(gameId: string, eventIds: string[]): Promise<AdoptScoresInput> {
    await service.begin(gameId, 'baseline');
    for (const eventId of eventIds)
      await service.evaluate(gameId, eventId, 'baseline', async () => result(80));
    await service.complete(gameId, 'baseline');
    await service.deliverPending('baseline');
    const selections = eventIds.map((eventId) => {
      const refs: Partial<Record<'quality' | 'verdict', ScoreReference>> = {};
      for (const score of [...platform.scores.values()].filter(
        (candidate) => candidate.metadata?.eventId === eventId,
      )) {
        const human: PlatformScore = {
          ...structuredClone(score),
          id: randomUUID(),
          source: 'ANNOTATION',
          value: score.dataType === 'NUMERIC' ? 95 : 'good',
          comment: '人工依据同一已提交行动复核',
          timestamp: '2026-06-01T10:00:00.000Z',
          metadata: {},
        };
        platform.scores.set([human.id, human.name, human.timestamp.slice(0, 10)].join('/'), human);
        refs[human.dataType === 'NUMERIC' ? 'quality' : 'verdict'] = {
          id: human.id,
          name: human.name,
          timestamp: human.timestamp,
        };
      }
      return { eventId, quality: refs.quality!, verdict: refs.verdict! };
    });
    return { runId: 'human-adoption', definitionRunId: 'baseline', selections };
  }

  it('原批次尚未确认上报时显式采用已有外部评分，之后清理正文不改变采用身份', async () => {
    const { game, events } = await fixture(1);
    const runId = 'unconfirmed-original';
    await service.begin(game.id, runId);
    await service.evaluate(game.id, events[0].id, runId, async () => result());
    platform.loseNextWriteResponse = true;
    await expect(service.deliverPending(runId)).rejects.toThrow('响应丢失');
    await service.complete(game.id, runId);
    const scores = [...platform.scores.values()];
    const reference = (dataType: string) => {
      const { id, name, timestamp } = scores.find((score) => score.dataType === dataType)!;
      return { id, name, timestamp };
    };
    const input = {
      runId: 'explicit-from-unconfirmed',
      definitionRunId: runId,
      selections: [
        { eventId: events[0].id, quality: reference('NUMERIC'), verdict: reference('CATEGORICAL') },
      ],
    };
    await service.adopt(game.id, input);
    await service.deliverPending(runId);
    platform.offline = true;
    await expect(service.adopt(game.id, input)).resolves.toBeUndefined();
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({
      score: 80,
      evaluationRunId: input.runId,
      source: { resultOrigin: 'langfuse' },
    });
  });

  it('人工结果只能显式完整采用，重试同一选择不创建新历史也不调用模型', async () => {
    const { game, events } = await fixture();
    const input = await humanSelection(
      game.id,
      events.map((event) => event.id),
    );
    expect((await prisma.decisionJudgment.findMany()).map((row) => row.score)).toEqual([80, 80]);
    const requestsBeforeAdoption = platform.batches.length;
    await service.adopt(game.id, input);
    const adopted = await prisma.decisionJudgment.findMany();
    expect(
      adopted.every(
        (row) =>
          row.score === 95 &&
          row.evaluationRunId === input.runId &&
          row.modelName === 'langfuse:ANNOTATION',
      ),
    ).toBe(true);
    expect(platform.batches).toHaveLength(requestsBeforeAdoption);
    // PG 的 JSONB 会调整对象键顺序；相同选择也必须可重试，不能依赖 JSON 字符串顺序。
    platform.offline = true;
    await expect(service.adopt(game.id, structuredClone(input))).resolves.toBeUndefined();
    expect(await prisma.evaluationRun.count()).toBe(2);
    for (const entry of adopted) expect(entry.previousEvaluations).toEqual([]);
  });

  it('外部选择缺少行动或错绑另一个行动，均不能改变原投影', async () => {
    const { game, events } = await fixture();
    const input = await humanSelection(
      game.id,
      events.map((event) => event.id),
    );
    platform.invisible = true;
    await expect(service.adopt(game.id, input)).rejects.toThrow('完整可见');
    expect(await prisma.evaluationRun.count()).toBe(1);
    platform.invisible = false;
    await expect(
      service.adopt(game.id, { ...input, selections: input.selections.slice(0, 1) }),
    ).rejects.toThrow('全部行动');
    const swapped = structuredClone(input);
    swapped.selections[0].quality = swapped.selections[1].quality;
    await expect(service.adopt(game.id, swapped)).rejects.toThrow('对象或定义不匹配');
    expect(
      (await prisma.decisionJudgment.findMany()).every(
        (row) => row.score === 80 && row.evaluationRunId === 'baseline',
      ),
    ).toBe(true);
    expect(await prisma.evaluationRun.count()).toBe(1);
  });

  it('同一采用运行不可更换已冻结的 Score 身份，即便新分数同名同对象', async () => {
    const { game, events } = await fixture(1);
    const input = await humanSelection(
      game.id,
      events.map((event) => event.id),
    );
    await service.adopt(game.id, input);
    const changed = structuredClone(input);
    changed.selections[0].quality.id = randomUUID();
    await expect(service.adopt(game.id, changed)).rejects.toThrow('不能更换选择');
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 95, evaluationRunId: 'human-adoption' });
  });

  it('显式采用已登记但回读失败，通用恢复只补采用而不重新判分', async () => {
    const { game, events } = await fixture(1);
    const input = await humanSelection(
      game.id,
      events.map((event) => event.id),
    );
    platform.readsBeforeFailure = 1;
    await expect(service.adopt(game.id, input)).rejects.toThrow('采用回读暂时失败');
    expect(await prisma.evaluationRun.findUnique({ where: { id: input.runId } })).toMatchObject({
      status: 'pending',
      selection: expect.any(Object),
    });
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 80, evaluationRunId: 'baseline' });
    platform.readsBeforeFailure = null;
    const resumed = await service.resumableRun(game.id);
    expect(resumed).toBe(input.runId);
    const compute = jest.fn(async () => result(10));
    await expect(
      service.evaluate(game.id, events[0].id, resumed!, compute),
    ).resolves.toBeUndefined();
    await service.complete(game.id, resumed!);
    expect(compute).not.toHaveBeenCalled();
    expect(
      await prisma.decisionJudgment.findUnique({ where: { eventId: events[0].id } }),
    ).toMatchObject({ score: 95, evaluationRunId: input.runId });
  });

  it('狼队集体评分可定位提刀产物与批次，经验奖励随采用刷新且知识历史分不再回填', async () => {
    const { game } = await fixture(0);
    const player = game.players[0];
    const source = {
      actionKey: game.id + '/wolf-proposal/1',
      traceId: traceIdentity(game.id, 'proposal'),
      attemptId: randomUUID(),
      outputObservationId: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const proposal = await prisma.event.create({
      data: {
        gameId: game.id,
        actorId: player.id,
        sequence: 1,
        day: 1,
        phase: 'night',
        actionType: 'wolf_proposal',
        visibility: 'wolf',
        effectKey: source.actionKey,
        source,
        content: { seatNo: 1, targetSeatNo: 2 },
      },
    });
    const batchKey = game.id + '/wolf-proposals';
    await prisma.effectBatchCommit.create({
      data: {
        gameId: game.id,
        batchKey,
        payloadHash: 'c'.repeat(64),
        eventIds: [proposal.id],
        outcomes: [{ actorId: player.id, eventId: proposal.id, source }],
      },
    });
    const kill = await prisma.event.create({
      data: {
        gameId: game.id,
        sequence: 2,
        day: 1,
        phase: 'night',
        actionType: 'wolf_kill',
        visibility: 'wolf',
        content: { targetSeatNo: 2, proposalEventIds: [proposal.id] },
      },
    });
    const memory = await prisma.memory.create({
      data: {
        agentId: player.agentId,
        label: 'test',
        type: 'lesson',
        title: '测试经验',
        content: '选择目标前核对提刀理由',
      },
    });
    const usage = await prisma.memoryUsage.create({
      data: {
        memoryId: memory.id,
        gameId: game.id,
        playerId: player.id,
        eventId: proposal.id,
        scenario: 'night_action',
        actionType: 'wolf_proposal',
        day: 1,
        rewardScore: 12,
      },
    });
    const chunk = await prisma.knowledgeChunk.create({
      data: {
        sourceFile: 'test.md',
        articleTitle: '测试知识',
        role: 'werewolf',
        scenario: 'night_action',
        trigger: '提刀前',
        action: '核对提刀理由',
        content: '测试攻略',
      },
    });
    const knowledge = await prisma.knowledgeUsage.create({
      data: {
        chunkId: chunk.id,
        gameId: game.id,
        playerId: player.id,
        eventId: proposal.id,
        scenario: 'night_action',
        actionType: 'wolf_proposal',
        day: 1,
        rewardScore: 31,
      },
    });
    await service.begin(game.id, 'team');
    expect(await prisma.evaluationRun.findUnique({ where: { id: 'team' } })).toMatchObject({
      expectedEventIds: [kill.id],
    });
    await service.evaluate(game.id, kill.id, 'team', async () => result(86));
    expect(await prisma.memoryUsage.findUnique({ where: { id: usage.id } })).toMatchObject({
      rewardScore: 12,
    });
    await service.complete(game.id, 'team');
    await service.deliverPending('team');
    expect(await prisma.teamJudgment.findUnique({ where: { eventId: kill.id } })).toMatchObject({
      score: 86,
      faction: 'werewolf',
    });
    expect(await prisma.decisionJudgment.count()).toBe(0);
    expect(await prisma.memoryUsage.findUnique({ where: { id: usage.id } })).toMatchObject({
      rewardScore: 86,
      eventId: proposal.id,
    });
    expect(await prisma.knowledgeUsage.findUnique({ where: { id: knowledge.id } })).toMatchObject({
      rewardScore: 31,
      eventId: proposal.id,
      chunkId: chunk.id,
    });
    for (const score of platform.scores.values()) {
      expect(score.metadata).toMatchObject({
        actionSource: null,
        teamProposals: [{ eventId: proposal.id, actionKey: source.actionKey, source, batchKey }],
      });
    }
  });

  it('运行内模型和Prompt定义被冻结，标签或默认配置改变仅影响显式新运行', async () => {
    const { game, events } = await fixture();
    await service.begin(game.id, 'frozen-definition');
    const first = jest.fn(async (_definition: EvaluationDefinition) => result());
    await service.evaluate(game.id, events[0].id, 'frozen-definition', first);
    prompts.captureSnapshot.mockResolvedValueOnce({
      judge: { text: '后续标签文本', name: 'judge', version: 9, source: 'langfuse' },
    });
    llm.captureConfiguration.mockReturnValueOnce({
      modelName: 'judge-latest',
      baseUrl: 'http://new-model.invalid/v1',
    });
    await service.begin(game.id, 'frozen-definition');
    const second = jest.fn(async (_definition: EvaluationDefinition) => result());
    await service.evaluate(game.id, events[1].id, 'frozen-definition', second);
    expect(first.mock.calls[0][0]).toEqual(second.mock.calls[0][0]);
    expect(second.mock.calls[0][0]).toMatchObject({
      modelName: 'judge-test',
      baseUrl: 'http://model.invalid/v1',
      prompts: promptSnapshot,
    });
    await service.complete(game.id, 'frozen-definition');
    await service.begin(game.id, 'new-definition');
    const third = jest.fn(async (_definition: EvaluationDefinition) => result());
    await service.evaluate(game.id, events[0].id, 'new-definition', third);
    expect(third.mock.calls[0][0]).toMatchObject({
      modelName: 'judge-latest',
      baseUrl: 'http://new-model.invalid/v1',
      prompts: { judge: { text: '后续标签文本', version: 9 } },
    });
    expect(third.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });
});
