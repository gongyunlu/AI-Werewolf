import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GameExecution } from '../src/generated/prisma/client';
import type { VoteTurnCandidate } from '../src/game-engine/ports/vote-turn.port';
import type { ModelStageState } from '../src/llm/model-stage';
import type { PreparedTurnInput } from '../src/agent-runtime/agent-runtime.service';
import type { RecoveryManifest } from '../src/game-recovery/game-recovery.service';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import { VoteTurnAdapter } from '../src/game-executor/vote-turn.adapter';
import {
  GameRuntimeService,
  type VoteRoundRequest,
} from '../src/game-runtime/game-runtime.service';
import { PrismaCheckpointSaver } from '../src/game-runtime/prisma-checkpoint-saver';
import { decodeRecoveryValue, encodeRecoveryValue } from '../src/game-recovery/recovery-value';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { createTestExecution } from './helpers/execution-fixture';
import { createVoteFixture } from './helpers/vote-fixture';
import { PLAYER_TURN_PROMPT_NAMES } from '../src/observability/prompt-templates';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

interface ChildBarrier {
  type: 'barrier';
  mode: string;
  branches: number[];
  requests: Array<{ seat: number; kind: string; model: string; messages: unknown }>;
  persisted: Array<{ taskId: string; checkpointId: string; candidate: VoteTurnCandidate }>;
  heldCandidate?: VoteTurnCandidate;
  candidates?: VoteTurnCandidate[];
  committed?: Array<{ id: string; replayed: boolean }>;
  stageKey?: string;
  state?: ModelStageState;
}

function expectNoRepeatedBranches(
  calls: ReadonlyArray<readonly [{ seatNo: number }, ...unknown[]]>,
  saved: number[],
) {
  expect(calls.filter(([request]) => saved.includes(request.seatNo))).toHaveLength(0);
}

describe('普通投票图执行：真实持久边界与跨进程恢复', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let fixture: Awaited<ReturnType<typeof createVoteFixture>>;
  let writer: EventWriterService;
  let adapter: VoteTurnAdapter;
  let runtime: GameRuntimeService;
  const children = new Set<ReturnType<typeof spawn>>();
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
    adapter = new VoteTurnAdapter(fixture.game.runtime);
    runtime = new GameRuntimeService(prisma, writer, adapter, fixture.game.recovery!);
  });
  afterEach(async () => {
    for (const child of children) child.kill();
    children.clear();
    await fixture?.game.close();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  async function prepare() {
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
      new Date(Date.now() + 600_000),
    );
  }
  async function resume() {
    await fixture.game.recovery!.interrupt(fixture.gameId);
    return fixture.game.recovery!.prepareResume(fixture.gameId);
  }
  async function runResume() {
    return runtime.resumeVoteRound({
      execution: await resume(),
      phaseInstanceId: 'node/0/vote',
      signal: new AbortController().signal,
    });
  }
  function round(execution: GameExecution, phaseInstanceId = 'node/0/vote'): VoteRoundRequest {
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
  async function rows() {
    const where = { gameId: fixture.gameId };
    return {
      events: await prisma.event.findMany({ where, orderBy: { sequence: 'asc' } }),
      contexts: await prisma.decisionContext.findMany({ where, orderBy: { eventId: 'asc' } }),
      memories: await prisma.memoryUsage.findMany({ where, orderBy: { id: 'asc' } }),
      knowledge: await prisma.knowledgeUsage.findMany({ where, orderBy: { id: 'asc' } }),
      batches: await prisma.effectBatchCommit.findMany({ where, orderBy: { batchKey: 'asc' } }),
      outbox: await prisma.eventDeliveryOutbox.findMany({ where, orderBy: { deliveryKey: 'asc' } }),
      retrievals: await prisma.knowledgeRetrieval.findMany({
        where: { ...where, eventId: { not: null } },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function stages() {
    const records = await prisma.gameExecutionStep.findMany({
      where: { gameId: fixture.gameId, key: { startsWith: 'model-stage/' } },
      orderBy: { key: 'asc' },
    });
    return records.map((record) => ({
      key: record.key,
      state: decodeRecoveryValue<ModelStageState>(record.output),
    }));
  }
  async function tuple(checkpointId?: string) {
    const execution = await prisma.gameExecution.findUniqueOrThrow({
      where: { gameId: fixture.gameId },
    });
    return new PrismaCheckpointSaver(
      prisma,
      {
        gameId: fixture.gameId,
        generation: execution.generation,
        owner: execution.owner ?? '只读检查',
      },
      'node/0/vote',
    ).getTuple({
      configurable: {
        thread_id: fixture.gameId,
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    });
  }
  async function candidates() {
    return (await tuple())!.checkpoint.channel_values.candidates as VoteTurnCandidate[];
  }
  async function expectAdopted(turns: VoteTurnCandidate[]) {
    const saved = await rows();
    expect(saved.events).toHaveLength(6);
    expect(saved.contexts).toHaveLength(6);
    expect(saved.memories).toHaveLength(6);
    expect(saved.knowledge).toHaveLength(6);
    expect(saved.batches).toHaveLength(1);
    expect(saved.outbox).toHaveLength(1);
    expect(saved.retrievals).toHaveLength(6);
    const eventIds = saved.events.map((event) => event.id);
    expect(saved.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(saved.batches[0].eventIds).toEqual(eventIds);
    expect(saved.outbox[0]).toMatchObject({
      batchKey: saved.batches[0].batchKey,
      eventIds,
      firstSequence: 1,
      lastSequence: 6,
      playerDeaths: [],
      attempts: 0,
      deliveredAt: null,
    });
    const savedStages = await stages();
    const prepared = (await tuple())!.checkpoint.channel_values.prepared as PreparedTurnInput[];
    for (const turn of turns) {
      expect(turn.source).toMatchObject(
        prepared.find((input) => input.player.id === turn.reference.playerId)!.source,
      );
      const event = saved.events.find((row) => row.actorId === turn.reference.playerId)!;
      expect(event).toMatchObject({
        actionType: 'vote',
        effectKey: turn.source.actionKey,
        day: turn.reference.day,
        content: {
          voterSeatNo: turn.reference.seatNo,
          targetSeatNo:
            turn.reference.action.action === 'abstain' ? 0 : turn.reference.action.targetSeatNo,
          thinking: turn.reasoning,
        },
      });
      expect(saved.batches[0].outcomes).toContainEqual(
        expect.objectContaining({
          actorId: turn.reference.playerId,
          effectKey: turn.source.actionKey,
          source: turn.source,
          attributionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
      expect(event.source).toEqual(turn.source);
      expect(saved.contexts.find((row) => row.eventId === event.id)!.snapshot).toEqual(
        turn.attribution.snapshot,
      );
      expect(
        saved.memories
          .filter((row) => row.eventId === event.id)
          .map(({ memoryId, triggerMatched }) => ({ memoryId, triggerMatched })),
      ).toEqual(turn.attribution.memoryUsages);
      expect(
        saved.knowledge
          .filter((row) => row.eventId === event.id)
          .map(({ chunkId }) => ({ chunkId })),
      ).toEqual(turn.attribution.knowledgeUsages);
      expect(saved.retrievals.find((row) => row.id === turn.attribution.retrievalId)?.eventId).toBe(
        event.id,
      );
      expect(turn.reference.visibleThrough).toBe(0);
      expect(turn.source.outputObservationId).toBeTruthy();
      const state = savedStages.find(
        (entry) => entry.key === `model-stage/${turn.source.actionKey}/final`,
      )!.state;
      expect(turn.source.outputObservationId).toBe(state.output!.observationId);
    }
    return saved;
  }

  function launch(mode: string) {
    const child = spawn(
      process.execPath,
      [
        '--experimental-vm-modules',
        require.resolve('jest/bin/jest'),
        '--config',
        './test/jest-game-recovery-integration.json',
        '--runInBand',
        '--testRegex',
        'graph-vote-child\\.ts$',
        '--runTestsByPath',
        './test/helpers/graph-vote-child.ts',
      ],
      {
        cwd: resolve(__dirname, '..'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          VOTE_TEST_DATABASE: database.connectionString,
          VOTE_TEST_GAME: fixture.gameId,
          VOTE_TEST_MODE: mode,
        },
      },
    );
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClosed) => {
        child.on('close', (code, signal) => {
          children.delete(child);
          resolveClosed({ code, signal });
        });
      },
    );
    const barrier = new Promise<ChildBarrier>((resolveBarrier, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`子进程没有到达持久屏障：${mode}\n${stdout}\n${stderr}`)),
        30_000,
      );
      child.on('message', (message: ChildBarrier) => {
        if (message.type === 'barrier') {
          clearTimeout(timer);
          resolveBarrier(message);
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      void closed.then(({ code, signal }) => {
        clearTimeout(timer);
        return reject(
          new Error(`子进程提前退出：${mode} code=${code} signal=${signal}\n${stdout}\n${stderr}`),
        );
      });
    });
    return {
      barrier,
      stop: async () => {
        child.send({ action: 'exit' });
        const result = await closed;
        expect(result).toEqual({ code: 73, signal: null });
      },
      diagnose: async (error: unknown) => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        const result = await closed;
        const directory = resolve(__dirname, '../../../docs/verification');
        await mkdir(directory, { recursive: true });
        const path = resolve(directory, `graph-child-${mode}-${fixture.gameId}.json`);
        await writeFile(
          path,
          JSON.stringify(
            {
              mode,
              ...result,
              stdout,
              stderr,
              error: error instanceof Error ? error.stack : String(error),
            },
            null,
            2,
          ),
        );
      },
    };
  }
  async function atBarrier(mode: string, inspect: (message: ChildBarrier) => Promise<void>) {
    const child = launch(mode);
    try {
      const message = await child.barrier;
      await inspect(message);
      await child.stop();
      return message;
    } catch (error) {
      await child.diagnose(error);
      throw error;
    }
  }

  it('原子采用完整来源和归因，图路径退出旧节点及回合完成日志', async () => {
    const committed = await runtime.runVoteRound(round(await prepare()));
    expect(committed).toHaveLength(6);
    await expectAdopted(await candidates());
    const keys = await prisma.gameExecutionStep.findMany({
      where: { gameId: fixture.gameId },
      select: { key: true },
    });
    expect(keys).toHaveLength(12);
    expect(keys.every(({ key }) => key.startsWith('model-stage/'))).toBe(true);
    expect(
      new Set((await stages()).map(({ key }) => key.replace(/\/(thinking\/\d+|final)$/, ''))).size,
    ).toBe(6);
    expect(fixture.game.model.requests).toHaveLength(12);
  });

  it('伪造旧节点完成记录不代替图候选', async () => {
    const execution = await prepare();
    await prisma.gameExecutionStep.create({
      data: {
        gameId: fixture.gameId,
        key: 'node/0/vote',
        completed: true,
        output: encodeRecoveryValue({ ok: true, value: { fake: true } }),
      },
    });
    await runtime.runVoteRound(round(execution));
    expect(fixture.game.model.requests).toHaveLength(12);
    await expectAdopted(await candidates());
  });

  it('冻结输入事务提交前不发模型请求，首次渲染使用 manifest 的 Prompt', async () => {
    const execution = await prepare();
    const manifest = decodeRecoveryValue<RecoveryManifest>(execution.manifest);
    for (const prompt of Object.values(manifest.prompts))
      prompt.text = `冻结模板验证\n${prompt.text}`;
    await prisma.gameExecution.update({
      where: { gameId: fixture.gameId },
      data: { manifest: encodeRecoveryValue(manifest) },
    });
    jest
      .spyOn(fixture.game.prompts, 'captureGameSnapshot')
      .mockRejectedValue(new Error('不允许重采模板'));
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      reached = resolveHeld;
    });
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let stopped = false;
    const observed = prisma.$extends({
      query: {
        graphCheckpoint: {
          async upsert({ args, query }) {
            const row = await query(args);
            const checkpoint = row.checkpoint as { channel_values?: { prepared?: unknown } };
            if (!stopped && checkpoint.channel_values?.prepared) {
              stopped = true;
              reached();
              await gate;
            }
            return row;
          },
        },
      },
    });
    const observedRuntime = new GameRuntimeService(
      observed as unknown as PrismaService,
      writer,
      adapter,
      fixture.game.recovery!,
    );
    const generation = jest.spyOn(adapter, 'vote');
    const running = observedRuntime.runVoteRound(round(execution));
    await held;
    await new Promise<void>((done) => setImmediate(done));
    expect(fixture.game.model.requests).toHaveLength(0);
    expect(generation).not.toHaveBeenCalled();
    expect(await stages()).toHaveLength(0);
    expect((await tuple())!.checkpoint.channel_values.prepared).toBeUndefined();
    release();
    await running;
    const frozen = (await tuple())!.checkpoint.channel_values.prepared as PreparedTurnInput[];
    for (const input of frozen) expect(input.prompts).toEqual(manifest.prompts);
    expect(
      fixture.game.model.requests.every(({ messages }) =>
        JSON.stringify(messages).includes('冻结模板验证'),
      ),
    ).toBe(true);
    await expectAdopted(await candidates());
  });

  it('生成前已冻结模型能力，恢复不采用重启后的协议声明', async () => {
    const execution = await prepare();
    const stopped = jest.spyOn(adapter, 'vote').mockRejectedValue(new Error('生成前退出'));
    await expect(runtime.runVoteRound(round(execution))).rejects.toThrow('生成前退出');
    stopped.mockRestore();
    expect(await stages()).toHaveLength(0);
    expect(fixture.game.model.requests).toHaveLength(0);
    const original = (await tuple())!.checkpoint.channel_values.prepared;
    fixture.game.config.MODEL_CAPABILITIES = JSON.stringify(
      JSON.parse(fixture.game.config.MODEL_CAPABILITIES!).map((entry: object) => ({
        ...entry,
        protocol: 'jsonMode',
        allowCodeFence: true,
        disableReasoning: true,
      })),
    );
    const protocols: string[] = [];
    jest.mocked(ChatOpenAI).mockImplementation((options) => {
      const model = fixture.game.model.create(String(options?.model));
      return {
        ...model,
        withStructuredOutput: (
          schema: Parameters<typeof model.withStructuredOutput>[0],
          settings: { method: string },
        ) => {
          protocols.push(settings.method);
          return model.withStructuredOutput(schema);
        },
      } as never;
    });
    await runResume();
    expect(protocols).toEqual(Array(6).fill('jsonSchema'));
    expect((await tuple())!.checkpoint.channel_values.prepared).toEqual(original);
    expect(fixture.game.model.requests).toHaveLength(12);
    await expectAdopted(await candidates());
  });

  it('冻结来源缺失时明确失败，不重新创建 attempt 或请求模型', async () => {
    const execution = await prepare();
    const prepareInput = adapter.prepare.bind(adapter);
    jest.spyOn(adapter, 'prepare').mockImplementation(async (request) => {
      const input = await prepareInput(request);
      return { ...input, source: undefined } as unknown as PreparedTurnInput;
    });
    const failure = await runtime
      .runVoteRound(round(execution))
      .catch((error: Error & { errors?: Error[] }) => error);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).toContain(
      '持久回合缺少冻结输入或原来源',
    );
    expect(fixture.game.model.requests).toHaveLength(0);
    expect(await stages()).toHaveLength(0);
    for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
    expect(await prisma.gameExecutionStep.count({ where: { gameId: fixture.gameId } })).toBe(0);
  });

  it.each(['same', 'day', 'voters', 'order', 'alive', 'legal'] as const)(
    '同阶段 %s 参数再次开始明确失败，恢复入口不接收业务输入',
    async (field) => {
      await runtime.runVoteRound(round(await prepare()));
      const original = await rows();
      const request = round(await resume());
      if (field === 'day') request.day = 2;
      if (field === 'voters') request.voters.pop();
      if (field === 'order') request.voters.reverse();
      if (field === 'alive') request.voters[0].aliveSeatNos.pop();
      if (field === 'legal') request.voters[0].legalSeatNos.pop();
      const requested = fixture.game.model.requests.length;
      await expect(runtime.runVoteRound(request)).rejects.toThrow('投票阶段已有进度');
      expect(fixture.game.model.requests).toHaveLength(requested);
      expect(await rows()).toEqual(original);
    },
  );

  it.each([false, true])(
    '五份分支事务已独立读回后退出；丢失 pending writes 变异=%s',
    async (mutate) => {
      await prepare();
      const message = await atBarrier('pending', async ({ persisted, requests }) => {
        expect(persisted.map(({ candidate }) => candidate.reference.seatNo).toSorted()).toEqual([
          1, 2, 3, 4, 5,
        ]);
        expect(requests).toHaveLength(10);
        for (const record of persisted) {
          const saved = await tuple(record.checkpointId);
          expect(saved!.pendingWrites).toContainEqual([
            record.taskId,
            '__return__',
            record.candidate,
          ]);
        }
        for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
      });
      const originalStages = await stages();
      if (!mutate) {
        await resume();
        await atBarrier('takeover-read', async ({ persisted, requests, branches }) => {
          expect(persisted).toEqual(
            message.persisted.toSorted((a, b) => a.taskId.localeCompare(b.taskId)),
          );
          expect(requests).toHaveLength(0);
          expect(branches).toHaveLength(0);
          expect(await stages()).toEqual(originalStages);
          for (const record of persisted)
            expect((await tuple(record.checkpointId))!.pendingWrites).toContainEqual([
              record.taskId,
              '__return__',
              record.candidate,
            ]);
        });
      }
      const branches = jest.spyOn(adapter, 'vote');
      const prepareInputs = jest.spyOn(adapter, 'prepare');
      await prisma.player.updateMany({
        where: { gameId: fixture.gameId },
        data: { modelName: 'changed-model' },
      });
      if (mutate) {
        const get = PrismaCheckpointSaver.prototype.getTuple;
        jest.spyOn(PrismaCheckpointSaver.prototype, 'getTuple').mockImplementation(async function (
          this: PrismaCheckpointSaver,
          config,
        ) {
          const saved = await get.call(this, config);
          return saved ? { ...saved, pendingWrites: [] } : saved;
        });
      }
      await runResume();
      const savedSeats = message.persisted.map(({ candidate }) => candidate.reference.seatNo);
      if (mutate) {
        expect(branches).toHaveBeenCalledTimes(6);
        expect(() => expectNoRepeatedBranches(branches.mock.calls, savedSeats)).toThrow();
      } else expectNoRepeatedBranches(branches.mock.calls, savedSeats);
      expect(prepareInputs).not.toHaveBeenCalled();
      expect(fixture.game.model.requests.map(({ seat }) => seat)).toEqual([6, 6]);
      expect(fixture.game.model.requests.map(({ model }) => model)).toEqual([
        'mock-seat-6',
        'mock-seat-6',
      ]);
      for (const request of fixture.game.model.requests) {
        const text = JSON.stringify(request.messages);
        for (const { candidate } of message.persisted)
          expect(text).not.toContain(candidate.reasoning);
      }
      const frozen = (await tuple())!.checkpoint.channel_values.prepared as PreparedTurnInput[];
      expect(
        frozen.every((input) => !JSON.stringify(input.replay).includes('按本场测试预设行动')),
      ).toBe(true);
      const after = await stages();
      for (const before of originalStages)
        expect(after.find(({ key }) => key === before.key)).toEqual(before);
      const turns = await candidates();
      for (const { candidate } of message.persisted) expect(turns).toContainEqual(candidate);
      await expectAdopted(turns);
    },
    60_000,
  );

  it('阶段结果已提交而候选未返回时退出，恢复原输入、attempt 和成功 observation', async () => {
    await prepare();
    const message = await atBarrier('stage', async ({ heldCandidate, persisted, requests }) => {
      expect(heldCandidate!.reference.seatNo).toBe(6);
      expect(persisted).toHaveLength(5);
      expect(requests).toHaveLength(12);
      const saved = await stages();
      expect(saved).toHaveLength(12);
      expect(saved.every(({ state }) => state.attempts === 1 && !!state.output)).toBe(true);
      expect(
        saved.find(({ key }) => key === `model-stage/${heldCandidate!.source.actionKey}/final`)!
          .state.output!.observationId,
      ).toBe(heldCandidate!.source.outputObservationId);
      expect(
        (await tuple())!.pendingWrites!.some(
          ([, , value]) => (value as VoteTurnCandidate)?.reference?.seatNo === 6,
        ),
      ).toBe(false);
    });
    const originalStages = await stages();
    const originalPrepared = (await tuple())!.checkpoint.channel_values
      .prepared as PreparedTurnInput[];
    const execution = await prisma.gameExecution.findUniqueOrThrow({
      where: { gameId: fixture.gameId },
    });
    const manifest = decodeRecoveryValue<{ prompts: unknown }>(execution.manifest);
    for (const input of originalPrepared) {
      expect(input.prompts).toEqual(manifest.prompts);
      expect(input).not.toHaveProperty('access');
      expect(input).not.toHaveProperty('stages');
      expect(JSON.stringify(input)).not.toMatch(/mock-key|apiKey/);
      expect(input.source.attemptId).toBeTruthy();
      expect(input.source.startedAt).toBeTruthy();
    }
    // 外部资料已经变化。恢复若重新准备，新的资料会改变归因或输入哈希。
    await prisma.memory.updateMany({
      where: { agentId: { in: fixture.players.map((player) => player.agentId) } },
      data: { content: '恢复后新增的记忆内容' },
    });
    await prisma.knowledgeChunk.updateMany({ data: { content: '恢复后新增的检索内容' } });
    fixture.game.memory.retrieveExperience.mockRejectedValue(new Error('恢复不得重新检索记忆'));
    fixture.game.knowledge.retrieve.mockRejectedValue(new Error('恢复不得重新检索知识'));
    jest
      .spyOn(fixture.game.prompts, 'captureGameSnapshot')
      .mockRejectedValue(new Error('恢复不得刷新 Prompt'));
    // 采用已保存的阶段结果无需再次读取凭据或当前协议声明。
    fixture.game.config.ARK_BASE_URL = 'https://changed.invalid';
    fixture.game.config.ARK_API_KEY = '';
    fixture.game.config.MODEL_CAPABILITIES = '[]';
    const branches = jest.spyOn(adapter, 'vote');
    const prepareInputs = jest.spyOn(adapter, 'prepare');
    await runResume();
    expect(branches.mock.calls.map(([request]) => request.seatNo)).toEqual([6]);
    expect(prepareInputs).not.toHaveBeenCalled();
    expect(fixture.game.model.requests).toHaveLength(0);
    expect(await stages()).toEqual(originalStages);
    expect((await tuple())!.checkpoint.channel_values.prepared).toEqual(originalPrepared);
    const turns = await candidates();
    expect(turns).toContainEqual(message.heldCandidate);
    await expectAdopted(turns);
  }, 60_000);

  it.each(['reserved', 'response'])(
    '%s 窗口退出保留预占次数，未持久结果恢复只消耗原额度',
    async (mode) => {
      const execution = await prepare();
      await atBarrier(mode, async ({ requests }) => {
        expect(requests).toHaveLength(mode === 'reserved' ? 0 : 1);
        const saved = await stages();
        expect(saved).toHaveLength(1);
        expect(saved[0].state).toMatchObject({ attempts: 1 });
        expect(saved[0].state.output).toBeUndefined();
        for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
      });
      const before = (await stages())[0];
      await runResume();
      const after = (await stages()).find(({ key }) => key === before.key)!;
      expect(after.state.attempts).toBe(2);
      expect(after.state.deadline).toBe(before.state.deadline);
      expect(after.state.inputHash).toBe(before.state.inputHash);
      expect(fixture.game.model.requests).toHaveLength(12);
      expect(
        (await prisma.gameExecution.findUniqueOrThrow({ where: { gameId: fixture.gameId } }))
          .deadline,
      ).toEqual(execution.deadline);
      await expectAdopted(await candidates());
    },
    60_000,
  );

  it('前两次阶段结果已提交，第三次预占后发送前退出，恢复不重发前两次请求', async () => {
    await prepare();
    await atBarrier('third', async ({ requests }) => {
      expect(requests.map(({ seat }) => seat)).toEqual([1, 1]);
      const saved = await stages();
      expect(saved.filter(({ state }) => state.output)).toHaveLength(2);
      expect(saved.filter(({ state }) => !state.output)).toHaveLength(1);
    });
    const saved = await stages();
    await runResume();
    expect(fixture.game.model.requests).toHaveLength(10);
    expect(fixture.game.model.requests.some(({ seat }) => seat === 1)).toBe(false);
    const after = await stages();
    for (const before of saved) {
      const current = after.find(({ key }) => key === before.key)!;
      expect(current.state.deadline).toBe(before.state.deadline);
      expect(current.state.inputHash).toBe(before.state.inputHash);
      if (before.state.output) expect(current).toEqual(before);
      else expect(current.state.attempts).toBe(2);
    }
    await expectAdopted(await candidates());
  }, 60_000);

  it.each(['decision_contexts', 'memory_usages', 'knowledge_usages'])(
    '图提交中 %s 写失败时整个批次回滚，恢复候选不重入',
    async (table) => {
      const execution = await prepare();
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT reject_graph_vote CHECK (false) NOT VALID`,
      );
      try {
        await expect(runtime.runVoteRound(round(execution))).rejects.toThrow();
        for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT reject_graph_vote`);
      }
      const turns = await candidates();
      const branches = jest.spyOn(adapter, 'vote');
      const requested = fixture.game.model.requests.length;
      await runResume();
      expect(branches).not.toHaveBeenCalled();
      expect(fixture.game.model.requests).toHaveLength(requested);
      await expectAdopted(turns);
    },
  );

  it('业务事务已提交、图尚未保存成功时退出，恢复真实重试提交并保留全部归因', async () => {
    await prepare();
    let original!: Awaited<ReturnType<typeof rows>>;
    const message = await atBarrier('committed', async ({ candidates: turns, committed }) => {
      original = await expectAdopted(turns!);
      expect(committed!.map(({ id }) => id)).toEqual(original.events.map(({ id }) => id));
      expect((await tuple())!.checkpoint.channel_values.committed ?? []).toHaveLength(0);
    });
    const branches = jest.spyOn(adapter, 'vote');
    const commit = jest.spyOn(writer, 'writeVoteBatch');
    const committed = await runResume();
    expect(branches).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(fixture.game.model.requests).toHaveLength(0);
    expect(committed.map(({ id }) => id)).toEqual(message.committed!.map(({ id }) => id));
    expect(committed.every((event) => event.replayed)).toBe(true);
    expect(await rows()).toEqual(original);
  }, 60_000);

  it('持久候选跨进程提交，再换进程恢复仍保留同一来源和原子结果', async () => {
    await prepare();
    const generated = await atBarrier('candidates', async ({ candidates: turns }) => {
      expect(await candidates()).toEqual(turns);
      expect(turns).toHaveLength(6);
      for (const turn of turns!) expect(JSON.stringify(turn)).not.toContain('mock-key');
      for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
    });
    await resume();
    await atBarrier('complete', async ({ branches, requests, committed }) => {
      expect(branches).toHaveLength(0);
      expect(requests).toHaveLength(0);
      expect(committed).toHaveLength(6);
      await expectAdopted(generated.candidates!);
    });
    const original = await rows();
    await resume();
    await atBarrier('recommit', async ({ branches, requests, committed }) => {
      expect(branches).toHaveLength(0);
      expect(requests).toHaveLength(0);
      expect(committed!.map(({ id }) => id)).toEqual(original.events.map(({ id }) => id));
      expect(committed!.every((event) => event.replayed)).toBe(true);
      expect(await rows()).toEqual(original);
    });
  }, 90_000);

  it('没有检查点时恢复明确失败，不重新开始生成', async () => {
    await expect(
      runtime.resumeVoteRound({
        execution: await prepare(),
        phaseInstanceId: 'node/0/vote',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('没有可恢复的进度');
    expect(fixture.game.model.requests).toHaveLength(0);
    for (const value of Object.values(await rows())) expect(value).toHaveLength(0);
  });
});
