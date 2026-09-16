import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { VoteTurnCandidate } from '../src/game-engine/ports/vote-turn.port';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import { ExecutionOwnershipError } from '../src/game-recovery/game-recovery.service';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { createTestExecution, nextTestExecution } from './helpers/execution-fixture';
import { createVoteFixture, voteBatch } from './helpers/vote-fixture';
import { PLAYER_TURN_PROMPT_NAMES } from '../src/observability/prompt-templates';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

describe('普通投票采用：脚本模型与真实隔离 PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let fixture: Awaited<ReturnType<typeof createVoteFixture>>;
  let writer: EventWriterService;
  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  });
  afterAll(async () => database?.close());
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('投票测试禁止外部请求'));
    fixture = await createVoteFixture(prisma);
    writer = new EventWriterService(prisma, fixture.game.recovery);
  });
  afterEach(async () => {
    await fixture?.game.close();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  const rows = async () => {
    const where = { gameId: fixture.gameId };
    return {
      events: await prisma.event.findMany({ where, orderBy: { sequence: 'asc' } }),
      contexts: await prisma.decisionContext.findMany({ where, orderBy: { eventId: 'asc' } }),
      memories: await prisma.memoryUsage.findMany({ where, orderBy: { id: 'asc' } }),
      knowledge: await prisma.knowledgeUsage.findMany({ where, orderBy: { id: 'asc' } }),
      batches: await prisma.effectBatchCommit.findMany({ where, orderBy: { batchKey: 'asc' } }),
      outbox: await prisma.eventDeliveryOutbox.findMany({ where, orderBy: { deliveryKey: 'asc' } }),
      effects: await prisma.gameExecutionStep.findMany({
        where: { ...where, key: { contains: 'event-batch/vote/' } },
        orderBy: { key: 'asc' },
      }),
    };
  };
  async function run<T>(callback: () => Promise<T>) {
    const recovery = fixture.game.recovery!;
    if (!(await prisma.gameExecution.findUnique({ where: { gameId: fixture.gameId } })))
      await createTestExecution(
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
        new Date(Date.now() + 600_000),
      );
    return recovery.run(
      await nextTestExecution(prisma, fixture.gameId),
      new AbortController().signal,
      callback,
    );
  }

  it.each(['decision_contexts', 'memory_usages', 'knowledge_usages'])(
    '%s 写入失败时整批回滚，恢复 effect 也未完成',
    async (table) => {
      const turns = await fixture.generate();
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT reject_vote_adoption CHECK (false) NOT VALID`,
      );
      try {
        await expect(run(() => writer.writeVoteBatch(voteBatch(turns)))).rejects.toThrow();
        for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
        expect(
          await prisma.knowledgeRetrieval.count({
            where: { gameId: fixture.gameId, eventId: { not: null } },
          }),
        ).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT reject_vote_adoption`);
      }
      await run(() => writer.writeVoteBatch(voteBatch(turns)));
      const saved = await rows();
      expect(saved.events).toHaveLength(6);
      expect(saved.contexts).toHaveLength(6);
      expect(saved.memories).toHaveLength(6);
      expect(saved.knowledge).toHaveLength(6);
      expect(saved.effects).toHaveLength(1);
      expect(saved.outbox).toHaveLength(1);
    },
  );

  it('提交成功但响应丢失，重放返回首次完整结果且没有重复记录', async () => {
    const turns = await fixture.generate();
    await expect(
      run(async () => {
        await writer.writeVoteBatch(voteBatch(turns));
        throw new Error('响应丢失');
      }),
    ).rejects.toThrow('响应丢失');
    const original = await rows();
    const result = await run(() =>
      writer.writeVoteBatch(voteBatch(JSON.parse(JSON.stringify(turns)))),
    );
    expect(result.map((event) => event.id)).toEqual(original.events.map((event) => event.id));
    expect(result.every((event) => event.replayed)).toBe(true);
    expect(await rows()).toEqual(original);
  });

  it.each([
    'attemptId',
    'traceId',
    'outputObservationId',
    'startedAt',
    'usage',
    'snapshot',
    'cutoff',
  ])('重复提交的 %s 冲突明确失败，原事件和归因不变', async (field) => {
    const turns = await fixture.generate();
    await writer.writeVoteBatch(voteBatch(turns));
    const original = await rows();
    const changed: VoteTurnCandidate[] = JSON.parse(JSON.stringify(turns));
    if (field === 'usage') changed[0].attribution.memoryUsages = [];
    else if (field === 'snapshot') changed[0].attribution.snapshot.reasoning = '另一个候选';
    else if (field === 'cutoff') for (const turn of changed) turn.reference.visibleThrough += 1;
    else changed[0].source[field] = field === 'startedAt' ? '2026-09-17T00:00:00Z' : randomUUID();
    await expect(writer.writeVoteBatch(voteBatch(changed))).rejects.toThrow('冲突');
    expect(await rows()).toEqual(original);
  });

  it('事务内取消会回滚，失去执行权后连已提交批次也不能重放', async () => {
    const turns = await fixture.generate();
    const controller = new AbortController();
    // 在 createMany 已经写入后取消；EventWriter 在退出事务前检查 signal。
    // 真实事务客户端由扩展钩子观察，不用 mock 代替数据库写入。
    const extended = prisma.$extends({
      query: {
        decisionContext: {
          async createMany({ args, query }) {
            const result = await query(args);
            controller.abort(new Error('提交中取消'));
            return result;
          },
        },
      },
    }) as unknown as PrismaService;
    await expect(
      new EventWriterService(extended).writeVoteBatch(voteBatch(turns, controller.signal)),
    ).rejects.toThrow('提交中取消');
    for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
    await run(() => writer.writeVoteBatch(voteBatch(turns)));
    const original = await rows();
    await run(async () => {
      await fixture.game.recovery!.interrupt(fixture.gameId);
      await expect(writer.writeVoteBatch(voteBatch(turns))).rejects.toBeInstanceOf(
        ExecutionOwnershipError,
      );
    });
    expect(await rows()).toEqual(original);
  });

  it('旧内容哈希、outcomes 和 effect 保持兼容，只补齐原来源的缺失归因', async () => {
    const turns = await oldCommit();
    const original = await rows();
    const first = original.events[0];
    const turn = turns.find((item) => item.reference.playerId === first.actorId)!;
    await prisma.decisionContext.create({
      data: {
        eventId: first.id,
        gameId: first.gameId,
        playerId: first.actorId!,
        snapshot: turn.attribution.snapshot as never,
      },
    });
    const requestsBefore = fixture.game.model.requests.length;
    const replayed = await run(() =>
      fixture.game.recovery!.node(0, 'vote', {}, async () => {
        const recovered = await fixture.generate();
        expect(recovered).toEqual(turns);
        return writer.writeVoteBatch(voteBatch(recovered));
      }),
    );
    expect(fixture.game.model.requests).toHaveLength(requestsBefore);
    const adopted = await rows();
    expect(replayed.map((event) => event.id)).toEqual(original.events.map((event) => event.id));
    expect(adopted.events).toEqual(original.events);
    expect(adopted.effects).toEqual(original.effects);
    expect(adopted.batches[0].payloadHash).toBe(original.batches[0].payloadHash);
    expect(adopted.contexts).toHaveLength(6);
    expect(adopted.memories).toHaveLength(6);
    expect(adopted.knowledge).toHaveLength(6);
    await replayOld(turns);
    expect(await rows()).toEqual(adopted);
  });

  it('旧批次来源不同或旧快照冲突时不补挂新归因', async () => {
    const turns = await oldCommit();
    const changed = JSON.parse(JSON.stringify(turns));
    changed[0].source.attemptId = randomUUID();
    await expect(writer.writeVoteBatch(voteBatch(changed))).rejects.toThrow('冲突');
    const first = (await rows()).events[0];
    await prisma.decisionContext.create({
      data: {
        eventId: first.id,
        gameId: first.gameId,
        playerId: first.actorId!,
        snapshot: { reasoning: '其他来源' },
      },
    });
    const original = await rows();
    await expect(writer.writeVoteBatch(voteBatch(turns))).rejects.toThrow('旧投票归因');
    expect(await rows()).toEqual(original);
  });

  async function oldCommit() {
    let turns!: VoteTurnCandidate[];
    const decide = fixture.game.runtime.decide.bind(fixture.game.runtime);
    const oldSchema = jest
      .spyOn(fixture.game.runtime, 'decide')
      .mockImplementation((context, _schema, signal, options) =>
        decide(
          context,
          z.object({
            action: z.enum(['cast_vote', 'abstain']),
            targetSeatNo: z.number().int().optional(),
          }),
          signal,
          options,
        ),
      );
    await expect(
      run(() =>
        fixture.game.recovery!.node(0, 'vote', {}, async () => {
          turns = await fixture.generate();
          const { turns: _turns, ...oldInput } = voteBatch(turns);
          await writer.writeVoteBatch(oldInput);
          throw new Error('旧节点在归因前退出');
        }),
      ),
    ).rejects.toThrow('旧节点在归因前退出');
    oldSchema.mockRestore();
    return turns;
  }

  function replayOld(turns: VoteTurnCandidate[]) {
    return run(() =>
      fixture.game.recovery!.node(0, 'vote', {}, () => writer.writeVoteBatch(voteBatch(turns))),
    );
  }

  it.each(['snapshot', 'usage', 'retrieval'] as const)(
    '旧批次的冻结 %s 不符时拒绝补写',
    async (field) => {
      const turns = await oldCommit();
      if (field === 'snapshot') turns[0].attribution.snapshot.reasoning = '其他候选';
      if (field === 'usage') turns[0].attribution.memoryUsages = [];
      if (field === 'retrieval') turns[0].attribution.retrievalId = randomUUID();
      const original = await rows();
      await expect(replayOld(turns)).rejects.toThrow('旧投票归因与冻结产物不符');
      expect(await rows()).toEqual(original);
    },
  );

  it('旧批次即使来源相同，也不能凭当前传入资料补挂未经证明的归因', async () => {
    const turns = await fixture.generate();
    const { turns: _turns, ...oldInput } = voteBatch(turns);
    await writer.writeVoteBatch(oldInput);
    turns[0].attribution.memoryUsages = [];
    turns[0].attribution.snapshot.reasoning = '同一来源字段下篡改的快照';
    const original = await rows();
    await expect(writer.writeVoteBatch(voteBatch(turns))).rejects.toThrow();
    expect(await rows()).toEqual(original);
  });

  it.each(['on', 'off'] as const)(
    '实验 %s 保留冻结证据，不产生普通记忆使用或改变热度排序',
    async (arm) => {
      const before = await prisma.memory.findMany({
        where: { agentId: { in: fixture.players.map((player) => player.agentId) } },
        orderBy: { id: 'asc' },
      });
      const ids = [
        'rulesets/standard6p',
        'scenarios/vote',
        ...new Set(fixture.players.map((player) => `roles/${player.role}`)),
      ];
      const skills = Object.fromEntries(
        await Promise.all(
          ids.map(async (id) => [id, (await fixture.game.skills.loadRequiredSkill(id)).content]),
        ),
      );
      const experiment = {
        version: 1,
        arm,
        capturedAt: new Date().toISOString(),
        embeddingModel: 'test-embedding',
        memories: before.map((memory) => ({
          ...memory,
          createdAt: memory.createdAt.toISOString(),
          metadata: { role: 'any', scenario: 'vote', conditions: [] },
          embedding: [1, 0],
          rank: 1,
        })),
        globalPatterns: [],
        knowledgeChunkIds: [fixture.chunk.id],
        skills,
        prompts: await fixture.game.prompts.captureGameSnapshot(
          fixture.gameId,
          PLAYER_TURN_PROMPT_NAMES,
        ),
      };
      await prisma.game.update({
        where: { id: fixture.gameId },
        data: { experiment: JSON.parse(JSON.stringify(experiment)) },
      });
      const turns = await fixture.generate();
      expect(
        turns.every(
          (turn) => turn.attribution.experiment && turn.attribution.memoryUsages.length === 1,
        ),
      ).toBe(true);
      expect(fixture.game.memory.retrieveExperience).not.toHaveBeenCalled();
      expect(fixture.game.memory.retrieveActiveMemories).not.toHaveBeenCalled();
      expect(fixture.game.memory.retrieveFrozen).toHaveBeenCalledTimes(6);
      await writer.writeVoteBatch(voteBatch(turns));
      const result = await rows();
      expect(result.memories).toHaveLength(0);
      expect(result.contexts).toHaveLength(6);
      expect(result.knowledge).toHaveLength(arm === 'on' ? 6 : 0);
      expect(
        await prisma.memory.findMany({
          where: { id: { in: before.map((memory) => memory.id) } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
    },
  );

  it('候选在生成进程退出后可由新进程提交，提交进程退出后再重放原结果', async () => {
    await createTestExecution(
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
      new Date(Date.now() + 600_000),
    );
    const directory = await mkdtemp(resolve(tmpdir(), 'werewolf-vote-'));
    if (!directory.startsWith(resolve(tmpdir(), 'werewolf-vote-')))
      throw new Error('拒绝清理测试目录之外的文件');
    const path = resolve(directory, 'turns.json');
    const child = (mode: string) =>
      promisify(execFile)(
        process.execPath,
        [
          '--experimental-vm-modules',
          require.resolve('jest/bin/jest'),
          '--config',
          './test/jest-game-recovery-integration.json',
          '--runInBand',
          '--testRegex',
          'vote-process-child\\.ts$',
          '--runTestsByPath',
          './test/helpers/vote-process-child.ts',
        ],
        {
          cwd: resolve(__dirname, '..'),
          windowsHide: true,
          timeout: 30_000,
          env: {
            ...process.env,
            VOTE_TEST_DATABASE: database.connectionString,
            VOTE_TEST_GAME: fixture.gameId,
            VOTE_TEST_ARTIFACT: path,
            VOTE_TEST_MODE: mode,
          },
        },
      ).catch((error: { code: number; stdout: string; stderr: string }) => {
        if (error.code !== 73) throw new Error(error.stdout + error.stderr);
        throw error;
      });
    try {
      await expect(child('generate')).rejects.toMatchObject({ code: 73 });
      const turns = JSON.parse(await readFile(path, 'utf8')) as VoteTurnCandidate[];
      expect(turns).toHaveLength(6);
      expect(await prisma.event.count({ where: { gameId: fixture.gameId } })).toBe(0);
      for (const turn of turns) {
        expect(turn.attribution.snapshot).toBeDefined();
        expect(turn).not.toHaveProperty('access');
      }
      await fixture.game.recovery!.interrupt(fixture.gameId);
      await fixture.game.recovery!.prepareResume(fixture.gameId);
      await expect(child('commit')).rejects.toMatchObject({ code: 73 });
      const original = await rows();
      expect(original.contexts).toHaveLength(6);
      expect(original.memories).toHaveLength(6);
      expect(original.knowledge).toHaveLength(6);
      expect(original.effects).toHaveLength(1);
      await fixture.game.recovery!.interrupt(fixture.gameId);
      await fixture.game.recovery!.prepareResume(fixture.gameId);
      await expect(child('replay')).rejects.toMatchObject({ code: 73 });
      const replayed = JSON.parse(await readFile(path + '.result', 'utf8')) as Array<{
        id: string;
        replayed: boolean;
      }>;
      expect(replayed.map((event) => event.id)).toEqual(original.events.map((event) => event.id));
      expect(replayed.every((event) => event.replayed)).toBe(true);
      expect(await rows()).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
