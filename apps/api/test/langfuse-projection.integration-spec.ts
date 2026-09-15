import { randomUUID } from 'node:crypto';
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

  function processServices(): EvaluationProjectionService {
    const settings: Record<string, string> = {
      LANGFUSE_HOST: 'http://langfuse.invalid',
      LANGFUSE_PUBLIC_KEY: 'test-public',
      LANGFUSE_SECRET_KEY: 'test-secret',
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
      await expect(service.evaluate(game.id, events[0].id, runId, compute)).rejects.toThrow('拒绝');
      const deliveredScores = structuredClone([...platform.scores.values()]);
      expect(deliveredScores).toHaveLength(2);
      // 模拟进程恢复且平台仍拒绝正文，不能靠可见的 Scores 误判交付成功。
      service = processServices();
      await expect(service.evaluate(game.id, events[0].id, runId, compute)).rejects.toThrow('拒绝');
      const pending = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(pending.deliveredEventIds).toEqual([]);
      expect(pending.pendingResults).toHaveProperty(events[0].id + '.result.score', 88);
      await expect(service.complete(game.id, runId)).rejects.toThrow();
      reject = false;
      await service.evaluate(game.id, events[0].id, runId, compute);
      await service.complete(game.id, runId);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(platform.scoreWrites()).toHaveLength(2);
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
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'project-frozen');
    const written = platform.batches.length;
    platform.projectId = 'foreign-project';
    const compute = jest.fn(async () => result());
    await expect(
      service.evaluate(game.id, events[0].id, 'project-frozen', compute),
    ).rejects.toThrow('项目');
    expect(compute).not.toHaveBeenCalled();
    expect(platform.batches).toHaveLength(written);
  });

  it('主动重评替代未采用运行时清除其临时全量评分和 Prompt，迟到任务不能复活', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'abandoned');
    await service.evaluate(game.id, events[0].id, 'abandoned', async () => result());
    const before = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'abandoned' } });
    expect(before.pendingResults).toHaveProperty(events[0].id + '.result');
    expect(before.definition).toHaveProperty('prompts');
    await service.begin(game.id, 'replacement');
    const old = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: 'abandoned' } });
    expect(old).toMatchObject({ status: 'superseded', pendingResults: {}, deliveredEventIds: [] });
    expect(old.definition).not.toHaveProperty('prompts');
    expect(old.pendingResults).toEqual({});
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

  it('observation 开始和完成使用独立交付 ID，业务 observation ID 保持稳定', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'delivery-ids');
    await service.evaluate(game.id, events[0].id, 'delivery-ids', async () => result());
    const sent = platform.batches.flat();
    expect(new Set(sent.map((entry) => entry.id)).size).toBe(sent.length);
    const evaluator = sent.filter((entry) => entry.body.name === 'domain-evaluator');
    expect(evaluator).toHaveLength(2);
    expect(evaluator[0].body.id).toBe(evaluator[1].body.id);
    // 平台按外层时间合并；即使异步重排，开始输入也不能覆盖最终判分依据。
    expect(Date.parse(evaluator[1].timestamp)).toBeGreaterThan(Date.parse(evaluator[0].timestamp));
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

  it('判分落库后上报响应丢失，进程重建重试只交付且始终保持原评分日期', async () => {
    const { game, events } = await fixture(1);
    const runId = 'response-lost';
    await service.begin(game.id, runId);
    const originalDate = new Date('2025-01-01T23:59:59.000Z');
    await prisma.evaluationRun.update({ where: { id: runId }, data: { createdAt: originalDate } });
    const compute = jest.fn(async () => result());
    platform.loseNextWriteResponse = true;
    await expect(service.evaluate(game.id, events[0].id, runId, compute)).rejects.toThrow(
      '响应丢失',
    );
    const pending = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(pending.pendingResults).toHaveProperty(events[0].id + '.result.score', 80);
    expect(await prisma.decisionJudgment.count()).toBe(0);
    service = processServices();
    // HTTP 隔离平台的存储已持久成功；清除可见结果模拟异步索引延迟，迫使跨日重复上报。
    platform.invisible = true;
    await expect(service.evaluate(game.id, events[0].id, runId, compute)).rejects.toThrow(
      '完整可见',
    );
    platform.invisible = false;
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

  it('只完成半批不会写入投影；整批采用后清空临时结果且不追加旧历史', async () => {
    const { game, events } = await fixture();
    await Promise.all(events.map((event) => oldProjection(event)));
    await service.begin(game.id, 'whole-batch');
    await service.evaluate(game.id, events[0].id, 'whole-batch', async () => result(80));
    await expect(service.complete(game.id, 'whole-batch')).rejects.toThrow('尚未完整交付');
    const partial = await prisma.decisionJudgment.findMany({ orderBy: { eventId: 'asc' } });
    expect(partial.map((entry) => [entry.score, entry.evaluationRunId, entry.source])).toEqual([
      [30, 'historical-run', null],
      [30, 'historical-run', null],
    ]);
    await service.evaluate(game.id, events[1].id, 'whole-batch', async () => result(90));
    await service.complete(game.id, 'whole-batch');
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
    expect(platform.scores.size).toBe(4);
  });

  it('平台只保存一个维度时不误报完整；补交不再调用模型', async () => {
    const { game, events } = await fixture(1);
    await service.begin(game.id, 'missing-verdict');
    platform.qualityOnly = true;
    const compute = jest.fn(async () => result());
    await expect(
      service.evaluate(game.id, events[0].id, 'missing-verdict', compute),
    ).rejects.toThrow('完整可见');
    await expect(service.complete(game.id, 'missing-verdict')).rejects.toThrow('尚未完整交付');
    expect(await prisma.decisionJudgment.count()).toBe(0);
    platform.qualityOnly = false;
    await service.evaluate(game.id, events[0].id, 'missing-verdict', compute);
    await service.complete(game.id, 'missing-verdict');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(platform.scores.size).toBe(2);
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
