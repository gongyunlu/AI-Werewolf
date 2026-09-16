import { SpeechSummarizerService } from '../src/speech-summarizer/speech-summarizer.service';
import { createServer, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { Worker } from 'bullmq';
import type { PrismaService } from '../src/prisma/prisma.service';
import { GameRecoveryService } from '../src/game-recovery/game-recovery.service';
import { decodeRecoveryValue, encodeRecoveryValue } from '../src/game-recovery/recovery-value';
import type { ModelStageState } from '../src/llm/model-stage';
import { JobModelStages } from '../src/llm/job-model-stages';
import { speechJudgeSchema } from '../src/evaluation/judge-schema';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { createTestExecution, nextTestExecution } from './helpers/execution-fixture';
import { withLearningTestQueues } from './helpers/learning-test-queues';
import { stageModels } from './helpers/stage-models';

const trace = () => ({ callbacks: [], metadata: {}, tags: [], runName: 'final' });
const messages = [new HumanMessage('最终动作')];
const schema = z.object({ action: z.literal('hold') });
function send(response: ServerResponse, content: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(
    `data: ${JSON.stringify({
      id: 'script',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'script',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
  );
}

describe('模型阶段：真实 SDK、隔离数据库、队列与独立进程', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let gameId: string;
  let recovery: GameRecoveryService;
  let baseUrl: string;
  let requests: Record<string, any>[];
  let answer: (request: Record<string, any>, response: ServerResponse) => Promise<void> | void;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    try {
      await answer(body, response);
    } catch (error) {
      response.destroy(error as Error);
    }
  });
  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
    await prisma.ruleset.create({
      data: { id: 'standard6p', name: '模型阶段测试', playerCount: 6, definition: {} },
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await database?.close();
  });
  beforeEach(async () => {
    requests = [];
    answer = (request, response) =>
      send(response, request.response_format ? '{"action":"hold"}' : '完整思考');
    gameId = (
      await prisma.game.create({
        data: { rulesetId: 'standard6p', skillVersion: 'v1', status: 'running' },
      })
    ).id;
    recovery = new GameRecoveryService(prisma);
    await createTestExecution(
      prisma,
      gameId,
      {},
      { version: 2, prompts: {} },
      new Date(Date.now() + 120_000),
    );
  });
  const records = async () =>
    (
      await prisma.gameExecutionStep.findMany({
        where: { gameId, key: { contains: 'model-stage/' } },
        orderBy: { key: 'asc' },
      })
    ).map((row) => ({ key: row.key, ...decodeRecoveryValue<ModelStageState>(row.output) }));
  const run = async <T>(callback: () => Promise<T>) =>
    recovery.run(await nextTestExecution(prisma, gameId), new AbortController().signal, callback);
  const generate = () =>
    stageModels(baseUrl, recovery).generations.structured(
      'script',
      schema,
      messages,
      trace,
      undefined,
      undefined,
      undefined,
      undefined,
      'final',
    );
  async function child(mode: string) {
    try {
      await promisify(execFile)(
        process.execPath,
        [
          '--experimental-vm-modules',
          require.resolve('jest/bin/jest'),
          '--config',
          './test/jest-game-recovery-integration.json',
          '--runInBand',
          '--testRegex',
          'model-stage-child\\.ts$',
          '--runTestsByPath',
          './test/helpers/model-stage-child.ts',
        ],
        {
          cwd: resolve(__dirname, '..'),
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            STAGE_TEST_DATABASE: database.connectionString,
            STAGE_TEST_GAME: gameId,
            STAGE_TEST_URL: baseUrl,
            STAGE_TEST_MODE: mode,
          },
        },
      );
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      if (failed.code !== 73) throw new Error(failed.stdout + failed.stderr, { cause: error });
      throw error;
    }
  }
  async function resume() {
    await recovery.interrupt(gameId);
    await recovery.prepareResume(gameId);
  }

  it('修正预占后进程退出：已完成思考不重发，保留修正、原期限和三次总额度', async () => {
    let finals = 0;
    answer = (request, response) =>
      send(
        response,
        request.response_format ? (++finals === 1 ? '{' : '{"action":"hold"}') : '完整思考',
      );
    await expect(child('repair-crash')).rejects.toMatchObject({ code: 73 });
    const before = await records();
    expect(before.filter((row) => row.key.includes('thinking')).map((row) => row.attempts)).toEqual(
      [1, 1],
    );
    const first = before.find((row) => row.key.endsWith('/final'))!;
    expect(first).toMatchObject({ attempts: 2, repair: expect.stringContaining('未通过校验') });
    await resume();
    await child('complete');
    const saved = (await records()).find((row) => row.key.endsWith('/final'))!;
    expect(saved).toMatchObject({
      attempts: 3,
      deadline: first.deadline,
      output: { value: { action: 'hold' } },
    });
    expect(requests).toHaveLength(4);
    const count = requests.length;
    await run(() =>
      recovery.node(0, 'test', {}, async () => {
        throw new Error('已完成节点不得重发');
      }),
    );
    expect(requests).toHaveLength(count);
  }, 90_000);

  it('HTTP 成功但结果保存前退出，只补未保存阶段，不退还原请求次数', async () => {
    await expect(child('response-crash')).rejects.toMatchObject({ code: 73 });
    expect(requests).toHaveLength(3);
    await resume();
    await child('complete');
    expect(requests).toHaveLength(4);
    expect((await records()).find((row) => row.key.endsWith('/final'))?.attempts).toBe(2);
  }, 90_000);

  it('连续 503 耗尽三次，换服务实例并重新领取也不扩大预算', async () => {
    answer = (_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"脚本过载"}}');
    };
    await expect(run(generate)).rejects.toMatchObject({ code: 'transient' });
    recovery = new GameRecoveryService(prisma);
    await expect(run(generate)).rejects.toMatchObject({ code: 'transient' });
    expect(requests).toHaveLength(3);
    expect((await records())[0].attempts).toBe(3);
  });

  it('结果保存事务失败不触发模型重试，预占仍在且没有成功缓存', async () => {
    const extended = prisma.$extends({
      query: {
        gameExecutionStep: {
          async upsert({ args, query }) {
            const result = await query(args);
            if (decodeRecoveryValue<ModelStageState>(args.update.output).output)
              throw new Error('脚本保存失败');
            return result;
          },
        },
      },
    });
    recovery = new GameRecoveryService(extended as unknown as PrismaService);
    await expect(run(generate)).rejects.toThrow('脚本保存失败');
    expect(requests).toHaveLength(1);
    expect((await records())[0]).toMatchObject({ attempts: 1 });
    expect((await records())[0].output).toBeUndefined();
  });

  it('取消与执行权失效阻止晚到结果进入缓存', async () => {
    answer = async (_request, response) => {
      await prisma.gameExecution.update({
        where: { gameId },
        data: { generation: { increment: 1 } },
      });
      send(response, '{"action":"hold"}');
    };
    await expect(run(generate)).rejects.toThrow('执行权');
    expect((await records())[0].output).toBeUndefined();
    const controller = new AbortController();
    controller.abort(new Error('已取消'));
    await expect(
      stageModels(baseUrl).generations.structured(
        'script',
        schema,
        messages,
        trace,
        controller.signal,
      ),
    ).rejects.toThrow('已取消');
    expect(requests).toHaveLength(1);
  });

  it('旧版本已完成外层步骤可重放，未知旧请求预算明确拒绝', async () => {
    await prisma.gameExecution.update({
      where: { gameId },
      data: { manifest: encodeRecoveryValue({ version: 1, prompts: {} }) },
    });
    await run(() => recovery.value('decision/player/0', async () => ({ action: 'hold' })));
    await expect(run(() => recovery.value('decision/player/0', generate))).resolves.toEqual({
      action: 'hold',
    });
    await expect(run(generate)).rejects.toThrow('旧执行记录');
    expect(requests).toHaveLength(0);
  });

  it('发言索引越界和空白理由在缓存前进入同一个修正预算', async () => {
    let count = 0;
    answer = (_request, response) =>
      send(
        response,
        JSON.stringify({
          items: [
            { index: ++count === 1 ? 2 : 1, score: 60, verdict: 'fair', reasoning: '公开证据' },
          ],
        }),
      );
    await run(() =>
      stageModels(baseUrl, recovery).generations.structured(
        'script',
        speechJudgeSchema(1),
        messages,
        trace,
        undefined,
        undefined,
        undefined,
        undefined,
        'speech',
      ),
    );
    expect(requests).toHaveLength(2);
    expect((await records())[0].output?.value).toMatchObject({ items: [{ index: 1 }] });
    expect(
      speechJudgeSchema(1).safeParse({ items: [{ score: 60, verdict: 'fair', reasoning: '   ' }] })
        .success,
    ).toBe(false);
  });

  it('摘要部分提交后重启，使用原输入与模型结果补齐剩余记录', async () => {
    await prisma.event.createMany({
      data: [1, 2].map((seatNo) => ({
        gameId,
        sequence: seatNo,
        day: 1,
        phase: 'day',
        actionType: 'speech',
        visibility: 'public',
        content: { seatNo, speech: '公开发言' },
      })),
    });
    answer = (_request, response) =>
      send(
        response,
        JSON.stringify({
          summaries: [1, 2].map((seatNo) => ({ day: 1, seatNo, summary: '完整摘要' })),
        }),
      );
    const extended = prisma.$extends({
      query: {
        speechSummary: {
          async upsert({ args, query }) {
            const result = await query(args);
            if (args.create.seatNo === 2) throw new Error('第二条摘要写入失败');
            return result;
          },
        },
      },
    }) as unknown as PrismaService;
    const summarize = (db: PrismaService) => {
      const models = stageModels(baseUrl, recovery);
      return new SpeechSummarizerService(
        models.config,
        db,
        {} as never,
        { render: async () => ({ name: 'summary', text: '按给定发言分组生成完整摘要' }) } as never,
        models.traces,
        models.generations,
        recovery,
      ).generateDaySummaries(gameId, 3);
    };
    recovery = new GameRecoveryService(extended);
    await expect(run(() => summarize(extended))).rejects.toThrow('第二条摘要写入失败');
    expect(await prisma.speechSummary.count({ where: { gameId } })).toBe(1);
    recovery = new GameRecoveryService(prisma);
    await run(() => summarize(prisma));
    expect(await prisma.speechSummary.count({ where: { gameId } })).toBe(2);
    expect(requests).toHaveLength(1);
  });

  it('单次自定义期限覆盖持续输出的真实 HTTP 流', async () => {
    answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const interval = setInterval(
        () =>
          response.write(
            `data: ${JSON.stringify({ id: 'long', object: 'chat.completion.chunk', created: 1, model: 'script', choices: [{ index: 0, delta: { content: '持续内容' }, finish_reason: null }] })}\n\n`,
          ),
        10,
      );
      response.on('close', () => clearInterval(interval));
    };
    const { calls } = stageModels(baseUrl);
    await expect(
      calls.streamText('script', messages, undefined, undefined, trace(), undefined, {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      details: { reason: 'timeout', timeoutPhase: 'total', timeoutMs: 100 },
    });
    expect(requests).toHaveLength(1);
  });

  it('队列重试保留三次请求预算，锁令牌错误不能读取成功阶段', async () => {
    answer = (_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"脚本过载"}}');
    };
    await withLearningTestQueues(
      async ({ reflectionQueue, reflectionEvents, connection, prefix, workers }) => {
        const { generations } = stageModels(baseUrl);
        workers.push(
          new Worker(
            reflectionQueue.name,
            (job, token) =>
              generations.withJob(new JobModelStages(connection, job, token!), async () => {
                await expect(
                  new JobModelStages(connection, job, 'stale-token').initialize(),
                ).rejects.toThrow('执行权');
                return generations.invoke({
                  schema,
                  system: '测试',
                  user: '测试',
                  gameId,
                  playerId: gameId,
                  runName: 'review',
                  scenario: 'reflection',
                });
              }),
            { connection, prefix },
          ),
        );
        const job = await reflectionQueue.add(
          'review',
          {},
          { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
        );
        await expect(job.waitUntilFinished(reflectionEvents, 5000)).rejects.toThrow();
        expect(requests).toHaveLength(3);
        const saved = (await reflectionQueue.getJob(job.id!))!.data;
        expect(JSON.parse(saved.modelStates['stage/review']).attempts).toBe(3);
      },
    );
  });

  it('首次业务读取失败后重消费仍能获得第一次请求，旧 stalled 任务拒绝迁入', async () => {
    await withLearningTestQueues(
      async ({ reflectionQueue, reflectionEvents, connection, prefix, workers }) => {
        const { generations } = stageModels(baseUrl);
        workers.push(
          new Worker(
            reflectionQueue.name,
            (job, token) =>
              generations.withJob(new JobModelStages(connection, job, token!), async () => {
                if (job.attemptsMade === 0) throw new Error('首次数据库读取失败');
                return generations.invoke({
                  schema,
                  system: '测试',
                  user: '测试',
                  gameId,
                  playerId: gameId,
                  runName: 'review',
                  scenario: 'reflection',
                });
              }),
            { connection, prefix },
          ),
        );
        const job = await reflectionQueue.add(
          'review',
          {},
          { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
        );
        await expect(job.waitUntilFinished(reflectionEvents, 5000)).resolves.toMatchObject({
          output: { action: 'hold' },
        });
        expect(requests).toHaveLength(1);
        const old = await reflectionQueue.add('old', {}, { delay: 60_000 });
        old.attemptsStarted = 2;
        await expect(new JobModelStages(connection, old, 'old').initialize()).rejects.toThrow(
          '旧队列任务',
        );
      },
    );
  });
});
