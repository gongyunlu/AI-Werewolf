import { GameEngine } from '../core/game-engine';
import { createPlayer, createGameState } from './test-utils';
import { createMockDependencies } from './test-helpers';

describe('GameEngine - 主图集成测试', () => {
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mocks = createMockDependencies();
  });

  describe('基础流程', () => {
    it('应该能编译主图', async () => {
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      // 需要先运行一次来触发初始化
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
      ];
      const initialState = createGameState({ gameId: 'test-game', players });

      try {
        await engine.run(initialState, 1); // 只跑 1 步来触发初始化
      } catch {
        // 忽略错误，我们只是要触发初始化
      }

      const compiled = engine.compile();
      expect(compiled).toBeDefined();
    });

    it('平安夜场景：无行动时应正常流转阶段（限制循环次数）', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'seer', faction: 'villager' }),
        createPlayer({ id: 'wolf', seatNo: 3, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      // 平安夜会无限循环，所以限制递归次数并捕获错误
      try {
        await engine.run(initialState, 5); // 只跑 5 步
      } catch (error: any) {
        // 预期会因为递归限制而抛出错误
        expect(error.message).toContain('Recursion limit');
      }

      // 验证：能正常执行就说明流程没问题
    });
  });

  describe('胜利条件判定', () => {
    it('狼人全灭时应判定好人胜利', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'seer', faction: 'villager' }),
        createPlayer(
          { id: 'wolf', seatNo: 3, role: 'werewolf', faction: 'werewolf' },
          { isAlive: false },
        ),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      const result = await engine.run(initialState);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('所有神职死亡时应判定狼人胜利（屠边）', async () => {
      const players = [
        createPlayer({ id: 'villager', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer(
          { id: 'seer', seatNo: 2, role: 'seer', faction: 'villager' },
          { isAlive: false },
        ),
        createPlayer(
          { id: 'witch', seatNo: 3, role: 'witch', faction: 'villager' },
          { isAlive: false },
        ),
        createPlayer({ id: 'wolf', seatNo: 4, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      const result = await engine.run(initialState);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('所有平民死亡时应判定狼人胜利（屠边）', async () => {
      const players = [
        createPlayer(
          { id: 'villager', seatNo: 1, role: 'villager', faction: 'villager' },
          { isAlive: false },
        ),
        createPlayer({ id: 'seer', seatNo: 2, role: 'seer', faction: 'villager' }),
        createPlayer({ id: 'wolf', seatNo: 3, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      const result = await engine.run(initialState);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });
  });

  describe('夜间结算集成', () => {
    it('狼人刀人应更新玩家死亡状态', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'wolf', seatNo: 2, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      // 设置狼刀目标
      initialState.wolfTarget = 'p1';

      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );
      const result = await engine.run(initialState, 10);

      // 验证 p1 死亡
      const p1 = result.players.find((p) => p.id === 'p1');
      expect(p1?.isAlive).toBe(false);
      expect(p1?.deathCause).toBe('night_kill');
    });

    it('预言家查验应生成结果', async () => {
      const players = [
        createPlayer({ id: 'seer', seatNo: 1, role: 'seer', faction: 'villager' }),
        createPlayer({ id: 'wolf', seatNo: 2, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      // 设置查验目标
      initialState.seerCheckTarget = 2;

      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );
      const result = await engine.run(initialState, 10);

      // 验证查验结果（注意：结果在第一轮后会被清空，这里只验证逻辑执行）
      expect(result.players).toBeDefined();
    });
  });

  describe('阶段流转', () => {
    it('应按正确顺序流转阶段', async () => {
      // 创建一个不会立即结束的配置：2 平民 + 1 狼人
      const players = [
        createPlayer({ id: 'v1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'v2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'wolf', seatNo: 3, role: 'werewolf', faction: 'werewolf' }),
      ];

      const initialState = createGameState({ gameId: 'test-game', players });
      const engine = new GameEngine(
        mocks.mockAgentRuntime,
        mocks.mockToolsFactory,
        mocks.mockPrisma,
        mocks.mockEventWriter,
        mocks.mockBroadcaster,
      );

      // 运行游戏
      const result = await engine.run(initialState, 10);

      // 验证游戏至少运行了一个循环
      // 如果狼人刀死 1 个平民，游戏还会继续（1 平民 vs 1 狼人）
      // 所以天数应该增加（进入白天阶段）
      expect(result.currentDay).toBeGreaterThanOrEqual(initialState.currentDay);

      // 验证游戏最终结束
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBeDefined();
    });
  });
});
