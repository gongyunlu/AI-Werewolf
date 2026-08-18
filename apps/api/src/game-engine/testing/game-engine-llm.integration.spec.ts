import { Test, TestingModule } from '@nestjs/testing';
import { createPlayer, createGameState } from './test-utils';
import { createMockDependencies } from './test-helpers';
import { GameEngine } from '../core/game-engine';
import { GameEngineModule } from '../core/game-engine.module';

/**
 * GameEngine 真实 LLM 集成测试
 *
 * 注意：此测试需要：
 * 1. 有效的 OpenAI API Key（配置在 .env）
 * 2. 数据库连接
 * 3. 会产生真实的 LLM 调用费用
 *
 * 运行：npm test -- game-engine-llm.integration
 */
describe('GameEngine - 真实 LLM 集成测试', () => {
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mocks = createMockDependencies();
  });
  let module: TestingModule;
  let gameEngine: GameEngine;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [GameEngineModule],
    }).compile();

    gameEngine = module.get<GameEngine>(GameEngine);
  });

  afterAll(async () => {
    await module.close();
  });

  describe('依赖注入验证', () => {
    it('应该成功注入 GameEngine', () => {
      expect(gameEngine).toBeDefined();
      expect(gameEngine).toBeInstanceOf(GameEngine);
    });

    it('GameEngine 应该使用配置驱动的管道架构', () => {
      // 验证 GameEngine 使用了节点上下文
      expect((gameEngine as any).nodeContext).toBeDefined();

      // preset 在首次 run() 时才初始化，这里不验证
    });
  });

  describe.skip('真实 LLM 夜间决策（需要 API Key）', () => {
    it('应该使用真实 LLM 进行夜间决策', async () => {
      // 创建测试数据：需要在数据库中存在
      // TODO: 创建测试游戏和玩家数据
      const players = [
        createPlayer('wolf1', 1, { role: 'werewolf', faction: 'werewolf' }),
        createPlayer('seer', 2, { role: 'seer' }),
        createPlayer('villager', 3, { role: 'villager' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });

      // 运行一轮游戏（限制递归次数）
      const result = await gameEngine.run(initialState, 8);

      // 验证游戏运行
      expect(result).toBeDefined();
      expect(result.currentDay).toBeGreaterThan(1);

      // 验证有 LLM 决策结果
      // 注意：由于是真实 LLM，结果可能不确定
      console.log('游戏结果：', {
        currentDay: result.currentDay,
        isGameOver: result.isGameOver,
        winner: result.winner,
        alivePlayers: result.players.filter((p) => p.isAlive).length,
      });
    }, 60000); // 60 秒超时
  });

  describe('模拟决策（不需要 API Key）', () => {
    it('应该能使用模拟决策运行游戏', async () => {
      // 创建不带依赖的引擎（使用模拟决策）
      const engineWithoutLLM = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      const players = [
        createPlayer('wolf1', 1, { role: 'werewolf', faction: 'werewolf' }),
        createPlayer('villager', 2, { role: 'villager' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });

      const result = await engineWithoutLLM.run(initialState, 10);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBeDefined();
    });
  });
});
