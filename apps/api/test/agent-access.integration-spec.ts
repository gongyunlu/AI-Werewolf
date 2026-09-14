import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import type { Env } from '../src/config/env.validation';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { GameExecutorService } from '../src/game-executor/game-executor.service';
import type { GameRecoveryService } from '../src/game-recovery/game-recovery.service';
import { createMockGame, type MockGame } from '../src/game-engine/testing/mock-game-harness';
import { MockGameStore } from '../src/game-engine/testing/mock-game-store';
import { encryptAgentSecret } from '../src/agents/agent-secret';
import { createLearningTestDatabase } from './helpers/learning-test-database';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

const SECRET_KEY = 'c'.repeat(64);
const DEFAULT_ENDPOINT = 'https://mock.invalid';
const DEFAULT_API_KEY = 'mock-key';

interface BuiltGame {
  gameId: string;
  /** 模型名 → 该模型所有调用实际使用的端点与密钥 */
  used: Map<string, Set<string>>;
  finished: { isGameOver: boolean };
  executor: GameExecutorService;
  recovery: GameRecoveryService;
}

describe('局内模型调用使用的接入端点', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let config: Partial<Env>;
  // 保留到用例结束：恢复入口需要从同一装配里取执行器与恢复服务
  const openGames: MockGame[] = [];

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
    await prisma.ruleset.create({
      data: {
        id: 'standard6p',
        name: 'Agent access integration test',
        playerCount: 6,
        definition: new MockGameStore().ruleset.definition,
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Agent access tests prohibit network access'));
    config = {
      AGENT_SECRET_KEY: SECRET_KEY,
      GAME_MAX_DURATION_MS: 600_000,
      LLM_CALL_TIMEOUT_MS: 10_000,
    };
  });

  afterEach(async () => {
    for (const game of openGames.splice(0)) await game.close();
    jest.restoreAllMocks();
  });

  /** endpoints 按座号给出自带端点，未列出的玩家走环境变量默认接入。 */
  async function runGame(endpoints: Record<number, string>): Promise<BuiltGame> {
    const row = await prisma.game.create({
      data: { rulesetId: 'standard6p', skillVersion: 'v1', status: 'running' },
    });
    const gameId = row.id;
    for (const template of new MockGameStore().players) {
      const baseUrl = endpoints[template.seatNo] ?? null;
      const agent = await prisma.agent.create({
        data: {
          name: randomUUID(),
          defaultModelName: template.modelName,
          memoryLabel: 'default',
          baseUrl,
          apiKeyCiphertext: baseUrl
            ? encryptAgentSecret(`sk-seat-${template.seatNo}`, SECRET_KEY)
            : null,
          apiKeyHint: baseUrl ? `t-${template.seatNo}` : null,
        },
      });
      const { id: _id, agentId: _agentId, gameId: _gameId, ...data } = template;
      // 开局把端点冻结进玩家快照，与创建对局时的写入一致
      await prisma.player.create({
        data: {
          ...data,
          gameId,
          agentId: agent.id,
          accessBaseUrl: baseUrl ?? DEFAULT_ENDPOINT,
          accessUsesDefault: !baseUrl,
        },
      });
    }

    const game = await createMockGame('villager', config, { prisma, gameId, recovery: true });
    openGames.push(game);
    // 只统计本局产生的模型调用
    jest.mocked(ChatOpenAI).mockClear();
    const state = await game.executor.executeGame(gameId);

    const used = new Map<string, Set<string>>();
    for (const [options] of jest.mocked(ChatOpenAI).mock.calls) {
      const model = String(options?.model);
      const access = `${String(options?.configuration?.baseURL)}|${String(options?.apiKey)}`;
      used.set(model, (used.get(model) ?? new Set()).add(access));
    }
    return {
      gameId,
      used,
      finished: state as { isGameOver: boolean },
      executor: game.executor,
      recovery: game.recovery!,
    };
  }

  const expectSeat = (game: BuiltGame, seat: number, endpoint: string, apiKey: string) => {
    expect(game.used.get(`mock-seat-${seat}`)).toEqual(new Set([`${endpoint}|${apiKey}`]));
  };

  it('两局自带端点互换后各自跑完，同一局的每个玩家只落在自己的接入配置上', async () => {
    const first = await runGame({
      1: 'https://deepseek.example/v1',
      2: 'https://relay.example/v1',
    });
    const second = await runGame({
      1: 'https://relay.example/v1',
      2: 'https://deepseek.example/v1',
    });

    for (const [game, [seat1, seat2]] of [
      [first, ['https://deepseek.example/v1', 'https://relay.example/v1']],
      [second, ['https://relay.example/v1', 'https://deepseek.example/v1']],
    ] as const) {
      expect(game.finished.isGameOver).toBe(true);
      expectSeat(game, 1, seat1, 'sk-seat-1');
      expectSeat(game, 2, seat2, 'sk-seat-2');
      for (const seat of [3, 4, 5, 6]) expectSeat(game, seat, DEFAULT_ENDPOINT, DEFAULT_API_KEY);
    }
  });

  it('自带密钥不进入恢复检查点', async () => {
    const game = await runGame({ 1: 'https://deepseek.example/v1' });

    const steps = await prisma.gameExecutionStep.findMany({
      where: { gameId: game.gameId },
      select: { key: true, input: true, output: true },
    });
    // 检查点按节点嵌套命名，上下文的键形如 <node 前缀>context/<playerId>/<序号>
    const contexts = steps.filter((step) => step.key.includes('context/'));
    expect(contexts.length).toBeGreaterThan(0);

    // 整份执行日志都不该出现明文密钥
    expect(JSON.stringify(steps)).not.toContain('sk-seat-1');
    // 端点本身要留着：续跑按当时的端点重放
    expect(JSON.stringify(contexts.map((step) => step.output))).toContain(
      'https://deepseek.example/v1',
    );
  });

  it('恢复闸门保留已有检查点，接入是否匹配交给执行期校验', async () => {
    const game = await runGame({ 1: 'https://deepseek.example/v1' });
    const player = await prisma.player.findFirstOrThrow({
      where: { gameId: game.gameId, seatNo: 1 },
      select: { agentId: true },
    });

    // 失锁对局由恢复服务置为待恢复，这里直接落到该状态，只验证接入口的恢复闸门
    const setPendingRecovery = () =>
      prisma.game.update({
        where: { id: game.gameId },
        data: { status: GAME_STATUSES.PENDING_RECOVERY },
      });
    await setPendingRecovery();

    await prisma.agent.update({
      where: { id: player.agentId },
      data: {
        apiKeyCiphertext: encryptAgentSecret('sk-seat-1-rotated', SECRET_KEY),
        apiKeyHint: 'ated',
      },
    });
    await expect(game.recovery.prepareResume(game.gameId)).resolves.toMatchObject({
      gameId: game.gameId,
    });

    await setPendingRecovery();
    await prisma.agent.update({
      where: { id: player.agentId },
      data: { baseUrl: 'https://relay.example/v1' },
    });

    // 闸门不预检密钥；执行期发现端点变化后抛错，不能据此断言整局可继续完成。
    await expect(game.recovery.prepareResume(game.gameId)).resolves.toMatchObject({
      gameId: game.gameId,
    });
  });
});
