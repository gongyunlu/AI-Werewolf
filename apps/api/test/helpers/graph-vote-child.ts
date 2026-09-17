import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { VoteTurnCandidate } from '../../src/game-engine/ports/vote-turn.port';
import { EventWriterService } from '../../src/game-engine/events/event-writer.service';
import { VoteTurnAdapter } from '../../src/game-executor/vote-turn.adapter';
import { GameRuntimeService } from '../../src/game-runtime/game-runtime.service';
import { PrismaCheckpointSaver } from '../../src/game-runtime/prisma-checkpoint-saver';
import { ModelCallService } from '../../src/llm/model-call.service';
import * as stageStores from '../../src/game-recovery/stage-record-store';
import { createVoteFixture, voteBatch } from './vote-fixture';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

const waitForExit = () => new Promise<never>(() => {});

it('在独立进程运行投票，在明确持久边界等待父进程终止', async () => {
  const connectionString = process.env.VOTE_TEST_DATABASE!;
  if (!/^\/werewolf_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname))
    throw new Error('子进程拒绝访问非测试数据库');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  }) as unknown as PrismaService;
  const gameId = process.env.VOTE_TEST_GAME!;
  const mode = process.env.VOTE_TEST_MODE!;
  // Jest 的沙箱 process.send 是空实现，IPC 必须使用 Node 的实际进程对象。
  const nativeProcess = process.getBuiltinModule('process');
  if (!nativeProcess.send) throw new Error('子进程故障测试需要 IPC 通道');
  nativeProcess.on('message', (message: { action?: string }) => {
    if (message.action === 'exit') nativeProcess.exit(73);
  });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('子进程禁止外部请求'));
  const fixture = await createVoteFixture(prisma, gameId);
  const recovery = fixture.game.recovery!;
  const adapter = new VoteTurnAdapter(fixture.game.runtime);
  const writer = new EventWriterService(prisma, recovery);
  const execution = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
  const persisted = new Map<
    string,
    { taskId: string; checkpointId: string; candidate: VoteTurnCandidate }
  >();
  let heldCandidate: VoteTurnCandidate | undefined;
  let holding = false;
  let notified = false;
  const branches: number[] = [];
  let releaseSecond!: () => void;
  const secondReady = new Promise<void>((resolveReady) => {
    releaseSecond = resolveReady;
  });
  const notify = (extra: object = {}) => {
    if (notified) return;
    notified = true;
    nativeProcess.send!({
      type: 'barrier',
      mode,
      branches,
      requests: fixture.game.model.requests.map(({ seat, kind, model, messages }) => ({
        seat,
        kind,
        model,
        messages,
      })),
      persisted: [...persisted.values()],
      heldCandidate,
      ...extra,
    });
  };
  const maybeNotify = () => {
    if (holding && persisted.size === 5) notify();
  };
  const putWrites = PrismaCheckpointSaver.prototype.putWrites;
  jest.spyOn(PrismaCheckpointSaver.prototype, 'putWrites').mockImplementation(async function (
    this: PrismaCheckpointSaver,
    config,
    writes,
    taskId,
  ) {
    await putWrites.call(this, config, writes, taskId);
    // 只有事务已经提交才发出屏障；父进程还会用自己的连接逐份读回。
    for (const [channel, value] of writes) {
      const candidate = value as VoteTurnCandidate | undefined;
      if (channel === '__return__' && candidate?.reference?.playerId) {
        persisted.set(candidate.reference.playerId, {
          taskId,
          checkpointId: config.configurable!.checkpoint_id,
          candidate,
        });
      }
    }
    if (mode === 'pending' || mode === 'stage') maybeNotify();
  });
  const vote = adapter.vote.bind(adapter);
  jest.spyOn(adapter, 'vote').mockImplementation(async (request, options) => {
    branches.push(request.seatNo);
    if (mode === 'third') {
      if (request.seatNo > 2) return waitForExit();
      if (request.seatNo === 2) await secondReady;
    }
    if ((mode === 'reserved' || mode === 'response') && request.seatNo !== 6) return waitForExit();
    if (mode === 'pending' && request.seatNo === 6) {
      holding = true;
      maybeNotify();
      return waitForExit();
    }
    const candidate = await vote(request, options);
    if (mode === 'third' && request.seatNo === 1) releaseSecond();
    if (mode === 'stage' && request.seatNo === 6) {
      heldCandidate = candidate;
      holding = true;
      maybeNotify();
      return waitForExit();
    }
    return candidate;
  });
  if (mode === 'reserved' || mode === 'third') {
    const createStore = stageStores.createStageRecordStore;
    jest.spyOn(stageStores, 'createStageRecordStore').mockImplementation((options) => {
      const store = createStore(options);
      return {
        update: async (label, change) => {
          const state = await store.update(label, change);
          if (
            state.attempts === 1 &&
            !state.output &&
            !state.failure &&
            (mode === 'reserved' || options.prefix.includes(fixture.players[1].id))
          ) {
            notify({ stageKey: `${options.prefix}/${label}`, state });
            return waitForExit();
          }
          return state;
        },
      };
    });
  }
  if (mode === 'response') {
    const stream = ModelCallService.prototype.streamText;
    jest.spyOn(ModelCallService.prototype, 'streamText').mockImplementation(async function (
      this: ModelCallService,
      ...args
    ) {
      const response = await stream.apply(this, args);
      // 单次传输已返回，ModelStage 尚未收到结果，所以数据库里只应有预占。
      notify({ response });
      return waitForExit();
    });
  }
  const commit = writer.writeVoteBatch.bind(writer);
  if (mode === 'candidates' || mode === 'committed') {
    jest.spyOn(writer, 'writeVoteBatch').mockImplementation(async (input) => {
      if (mode === 'candidates') {
        notify({ candidates: input.turns });
        return waitForExit();
      }
      const committed = await commit(input);
      notify({ candidates: input.turns, committed });
      return waitForExit();
    });
  }
  const runtime = new GameRuntimeService(prisma, writer, adapter, recovery);
  const request = {
    execution,
    phaseInstanceId: 'node/0/vote',
    signal: new AbortController().signal,
  };
  if (mode === 'takeover-read') {
    await recovery.run(execution, request.signal, async () => {
      const scope = recovery.current!;
      const identity = { gameId, generation: scope.execution.generation, owner: scope.owner };
      const saved = await new PrismaCheckpointSaver(
        prisma,
        identity,
        request.phaseInstanceId,
      ).getTuple({ configurable: { thread_id: gameId } });
      for (const [taskId, channel, value] of saved!.pendingWrites!) {
        const candidate = value as VoteTurnCandidate;
        if (channel === '__return__' && candidate?.reference?.playerId)
          persisted.set(candidate.reference.playerId, {
            taskId,
            checkpointId: saved!.checkpoint.id,
            candidate,
          });
      }
      notify({ identity });
      return waitForExit();
    });
    throw new Error('接管进程没有在屏障处退出');
  }
  const committed =
    mode === 'recommit'
      ? await recovery.run(execution, request.signal, async (signal) => {
          const scope = recovery.current!;
          const identity = { gameId, generation: scope.execution.generation, owner: scope.owner };
          const saved = await new PrismaCheckpointSaver(
            prisma,
            identity,
            request.phaseInstanceId,
          ).getTuple({ configurable: { thread_id: gameId } });
          const turns = saved!.checkpoint.channel_values.candidates as VoteTurnCandidate[];
          return writer.writeVoteBatch({ ...voteBatch(turns, signal), execution: identity });
        })
      : mode === 'complete'
        ? await runtime.resumeVoteRound(request)
        : await runtime.runVoteRound({
            ...request,
            day: 1,
            voters: fixture.players.map((player) => ({
              playerId: player.id,
              seatNo: player.seatNo!,
              aliveSeatNos: fixture.players.map((entry) => entry.seatNo!),
              legalSeatNos: fixture.players.map((entry) => entry.seatNo!),
            })),
          });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  if (mode !== 'complete' && mode !== 'recommit') throw new Error(`没有命中进程退出屏障：${mode}`);
  notify({ committed });
  await waitForExit();
});
