import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import {
  abortExperiment,
  assertExperimentConfiguration,
  ExperimentInvalidError,
} from './experiment-integrity';
import type { ExperimentSnapshot } from './experiment-snapshot';
import type { PrismaService } from '../prisma/prisma.service';
import { SeerCheckNode } from '../game-engine/nodes/night/seer-check.node';
import { createGameState, createPlayer } from '../game-engine/testing/test-utils';

it('模型变化及冻结时钟缺失都使实验失效', () => {
  const snapshot = {
    embeddingModel: 'old',
    capturedAt: '2026-09-06T00:00:00.000Z',
  } as ExperimentSnapshot;
  expect(() => assertExperimentConfiguration(snapshot, 'new')).toThrow(ExperimentInvalidError);
  expect(() => assertExperimentConfiguration({ ...snapshot, capturedAt: '' }, 'old')).toThrow(
    ExperimentInvalidError,
  );
});

it.each([false, true])('实验中止时禁止回到普通行为降级（状态写入失败=%s）', async (fails) => {
  const prisma = {
    $executeRaw: fails
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn().mockResolvedValue(1),
  };
  await expect(
    abortExperiment(prisma as unknown as PrismaService, 'g', new Error('frozen retrieval failed')),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  const query = prisma.$executeRaw.mock.calls[0];
  expect(query[0].join('')).toContain("status = 'aborted'");
  expect(query[1]).toContain('frozen retrieval failed');
});

it('冻结记忆检索异常穿过 runtime 和预言家节点，不产生随机查验或模型调用', async () => {
  const prisma = {
    game: { findUnique: jest.fn().mockResolvedValue({ experiment: { version: 1 } }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    event: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const runtime = createAgentRuntime(
    ...([
      { get: jest.fn((key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 0 : undefined)) },
      prisma,
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  jest
    .spyOn(runtime as any, 'prepareContext')
    .mockRejectedValue(new ExperimentInvalidError('frozen retrieval failed'));
  const model = jest.spyOn(runtime, 'decide');
  const eventWriter = {
    writeNightPromptEvent: jest.fn().mockResolvedValue({}),
    writeSeerCheckEvent: jest.fn(),
  };
  const node = new SeerCheckNode(runtime).create()({ prisma, eventWriter } as never);
  const state = createGameState({
    gameId: 'g',
    players: [
      createPlayer('p', 1, 'seer', 'villager'),
      createPlayer('q', 2, 'werewolf', 'werewolf'),
    ],
  });
  await expect(node(state)).rejects.toBeInstanceOf(ExperimentInvalidError);
  expect(eventWriter.writeSeerCheckEvent).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
});

it('普通上下文错误保持原异常，不因对局属于实验而读取状态或标记失效', async () => {
  const prisma = { game: { findUnique: jest.fn() }, $executeRaw: jest.fn() };
  const runtime = createAgentRuntime(
    ...([
      { get: jest.fn((key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 0 : undefined)) },
      prisma,
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ] as unknown as Parameters<typeof createAgentRuntime>),
  );
  const error = new Error('temporary context error');
  jest.spyOn(runtime as any, 'prepareContext').mockRejectedValue(error);
  await expect(
    runtime.prepareContextPublic({
      gameId: 'g',
      playerId: 'p',
      scenario: 'vote',
      actionType: 'vote',
      position: { day: 1, phase: 'vote', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
    }),
  ).rejects.toBe(error);
  expect(prisma.game.findUnique).not.toHaveBeenCalled();
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
});
