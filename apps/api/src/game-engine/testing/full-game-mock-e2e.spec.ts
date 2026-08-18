import { GameEngine } from '../core/game-engine';
import { MemorySaver } from '@langchain/langgraph';
import { createMockDependencies } from './test-helpers';
import { Standard6pPreset } from '../presets/game-presets';
import { createGameState, createPlayer } from './test-utils';

/**
 * 完整对局端到端测试
 *
 * 目标：
 * 1. 验证从游戏开始到胜负判定的完整流程
 * 2. 验证夜间 + 白天流程串联
 * 3. 验证主图循环逻辑正确性
 *
 * 注意：
 * - Mock AgentRuntime 返回失败，触发节点的降级策略（随机决策）
 * - 不写数据库，纯内存测试
 * - 不依赖真实 LLM API，测试快速且稳定
 */
describe('GameEngine - Full Game E2E (模拟决策)', () => {
  let mocks: ReturnType<typeof createMockDependencies>;

  beforeEach(() => {
    mocks = createMockDependencies();
  });
  it('应该能跑完一个完整对局（模拟决策，限制步数）', async () => {
    const players = [
      createPlayer({ id: 'wolf1', seatNo: 1, role: 'werewolf', faction: 'werewolf' }),
      createPlayer({ id: 'wolf2', seatNo: 2, role: 'werewolf', faction: 'werewolf' }),
      createPlayer({ id: 'seer', seatNo: 3, role: 'seer', faction: 'villager' }),
      createPlayer({ id: 'witch', seatNo: 4, role: 'witch', faction: 'villager' }),
      createPlayer({ id: 'villager1', seatNo: 5, role: 'villager', faction: 'villager' }),
      createPlayer({ id: 'villager2', seatNo: 6, role: 'villager', faction: 'villager' }),
    ];

    const initialState = createGameState({
      gameId: 'test-full-game',
      players,
    });

    // 创建游戏引擎（使用 mock 依赖，agentRuntime 返回失败触发降级策略）
    const engine = new GameEngine(
      mocks.mockAgentRuntime,
      mocks.mockToolsFactory,
      mocks.mockPrisma,
      mocks.mockEventWriter,
      mocks.mockBroadcaster,
    );

    // 运行游戏（限制最多 100 步）
    const finalState = await engine.run(initialState, 100, new MemorySaver(), Standard6pPreset);

    // 验证：游戏应该结束
    expect(finalState.isGameOver).toBe(true);
    expect(finalState.winner).toBeDefined();
    expect(['werewolf', 'villager']).toContain(finalState.winner);

    // 验证：应该有玩家死亡
    const deadPlayers = finalState.players.filter((p) => !p.isAlive);
    expect(deadPlayers.length).toBeGreaterThan(0);

    // 验证：应该至少跑了 1 天
    expect(finalState.currentDay).toBeGreaterThanOrEqual(1);

    // 打印游戏结果
    console.log('');
    console.log('='.repeat(60));
    console.log(`✅ 游戏结束: ${finalState.winner} 获胜`);
    console.log(`   - 总天数: ${finalState.currentDay}`);
    console.log(
      `   - 存活玩家: ${finalState.players
        .filter((p) => p.isAlive)
        .map((p) => p.seatNo)
        .join(', ')}`,
    );
    console.log(
      `   - 死亡玩家: ${deadPlayers.map((p) => `${p.seatNo}号位(${p.role})`).join(', ')}`,
    );
    console.log('='.repeat(60));
    console.log('');
  }, 30000); // 30 秒超时

  it('应该在合理步数内结束（避免死循环）', async () => {
    const players = [
      createPlayer({ id: 'wolf1', seatNo: 1, role: 'werewolf', faction: 'werewolf' }),
      createPlayer({ id: 'villager1', seatNo: 2, role: 'villager', faction: 'villager' }),
      createPlayer({ id: 'villager2', seatNo: 3, role: 'villager', faction: 'villager' }),
    ];

    const initialState = createGameState({
      gameId: 'test-quick-game',
      players,
    });

    const engine = new GameEngine(
      mocks.mockAgentRuntime,
      mocks.mockToolsFactory,
      mocks.mockPrisma,
      mocks.mockEventWriter,
      mocks.mockBroadcaster,
    );

    // 3 人局应该很快结束
    const finalState = await engine.run(initialState, 50, new MemorySaver(), Standard6pPreset);

    expect(finalState.isGameOver).toBe(true);
    expect(finalState.currentDay).toBeLessThanOrEqual(10); // 不应该超过 10 天
  }, 20000);

  it('狼人全灭时应立即判定好人胜利', async () => {
    const players = [
      createPlayer(
        { id: 'wolf1', seatNo: 1, role: 'werewolf', faction: 'werewolf' },
        { isAlive: false },
      ),
      createPlayer({ id: 'villager1', seatNo: 2, role: 'villager', faction: 'villager' }),
      createPlayer({ id: 'villager2', seatNo: 3, role: 'villager', faction: 'villager' }),
    ];

    const initialState = createGameState({
      gameId: 'test-wolves-dead',
      players,
    });

    const engine = new GameEngine(
      mocks.mockAgentRuntime,
      mocks.mockToolsFactory,
      mocks.mockPrisma,
      mocks.mockEventWriter,
      mocks.mockBroadcaster,
    );

    const finalState = await engine.run(initialState, 10, new MemorySaver(), Standard6pPreset);

    expect(finalState.isGameOver).toBe(true);
    expect(finalState.winner).toBe('villager');
  });

  it('好人数量 ≤ 狼人数量时应判定狼人胜利', async () => {
    const players = [
      createPlayer({ id: 'wolf1', seatNo: 1, role: 'werewolf', faction: 'werewolf' }),
      createPlayer({ id: 'wolf2', seatNo: 2, role: 'werewolf', faction: 'werewolf' }),
      createPlayer({ id: 'villager1', seatNo: 3, role: 'villager', faction: 'villager' }),
      createPlayer(
        { id: 'villager2', seatNo: 4, role: 'villager', faction: 'villager' },
        { isAlive: false },
      ),
      createPlayer(
        { id: 'seer', seatNo: 5, role: 'seer', faction: 'villager' },
        { isAlive: false },
      ),
    ];

    const initialState = createGameState({
      gameId: 'test-wolves-win',
      players,
    });

    const engine = new GameEngine(
      mocks.mockAgentRuntime,
      mocks.mockToolsFactory,
      mocks.mockPrisma,
      mocks.mockEventWriter,
      mocks.mockBroadcaster,
    );

    const finalState = await engine.run(initialState, 10, new MemorySaver(), Standard6pPreset);

    expect(finalState.isGameOver).toBe(true);
    expect(finalState.winner).toBe('werewolf');
  });
});
