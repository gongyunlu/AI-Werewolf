import { resolveNightPhase, announceDayPhase } from './phase-resolvers';
import { checkWinNode } from '../nodes/shared/check-win.node';
import { createPlayer, createGameState } from '../testing/test-utils';

describe('resolveNightPhase - 夜间结算节点', () => {
  describe('狼刀击杀', () => {
    it('狼人刀杀目标应更新玩家状态为死亡', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer('p2', 2, { role: 'werewolf', faction: 'werewolf' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          wolfTarget: 'p1',
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.players).toBeDefined();
      const deadPlayer = result.players!.find((p) => p.id === 'p1');
      expect(deadPlayer?.isAlive).toBe(false);
      expect(deadPlayer?.deathDay).toBe(1);
      expect(deadPlayer?.deathCause).toBe('night_kill');
      expect(result.nightDeaths).toHaveLength(1);
      expect(result.nightDeaths![0]).toEqual({
        playerId: 'p1',
        cause: 'night_kill',
      });
    });

    it('无人被刀时应为平安夜', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          wolfTarget: null,
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.nightDeaths).toHaveLength(0);
      expect(result.players!.every((p) => p.isAlive)).toBe(true);
    });
  });

  describe('女巫用药', () => {
    it('女巫解药应救活被刀玩家', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer('witch', 2, { role: 'witch' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          wolfTarget: 'p1',
          witchAntidoteTarget: 'p1',
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.nightDeaths).toHaveLength(0);
      expect(result.players!.find((p) => p.id === 'p1')?.isAlive).toBe(true);

      // 女巫解药状态更新
      const witch = result.players!.find((p) => p.role === 'witch');
      expect(witch?.hasAntidoteUsed).toBe(true);
      expect(witch?.antidoteUsedOn).toBe('p1');
    });

    it('女巫毒药应独立生效', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer('witch', 3, { role: 'witch' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          wolfTarget: 'p1',
          witchPoisonTarget: 'p2',
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.nightDeaths).toHaveLength(2);
      expect(result.players!.find((p) => p.id === 'p1')?.isAlive).toBe(false);
      expect(result.players!.find((p) => p.id === 'p2')?.isAlive).toBe(false);

      // 女巫毒药状态更新
      const witch = result.players!.find((p) => p.role === 'witch');
      expect(witch?.hasPoisonUsed).toBe(true);
      expect(witch?.poisonUsedOn).toBe('p2');
    });
  });

  describe('预言家查验', () => {
    it('查验普通狼人应返回 werewolf', async () => {
      const players = [
        createPlayer('seer', 1, { role: 'seer' }),
        createPlayer('wolf', 2, { role: 'werewolf', faction: 'werewolf' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          seerCheckTarget: 2, // 查验 2 号位
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.seerCheckResult).toEqual({
        targetSeatNo: 2,
        result: 'werewolf',
      });
    });

    it('查验隐狼应返回 good', async () => {
      const players = [
        createPlayer('seer', 1, { role: 'seer' }),
        createPlayer('hidden', 2, { role: 'hidden_wolf', faction: 'werewolf' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          seerCheckTarget: 2,
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.seerCheckResult).toEqual({
        targetSeatNo: 2,
        result: 'good',
      });
    });

    it('查验好人应返回 good', async () => {
      const players = [
        createPlayer('seer', 1, { role: 'seer' }),
        createPlayer('villager', 2, { role: 'villager' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          seerCheckTarget: 2,
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.seerCheckResult).toEqual({
        targetSeatNo: 2,
        result: 'good',
      });
    });

    it('未查验时不应生成查验结果', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          seerCheckTarget: null,
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.seerCheckResult).toBeNull();
    });
  });

  describe('状态清理', () => {
    it('夜间结算后应清空行动目标', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          wolfTarget: 'p1',
          witchAntidoteTarget: 'p1',
          seerCheckTarget: 2,
        },
      );

      const result = await resolveNightPhase(state);

      expect(result.wolfTarget).toBeNull();
      expect(result.witchAntidoteTarget).toBeNull();
      expect(result.witchPoisonTarget).toBeNull();
      expect(result.seerCheckTarget).toBeNull();
    });

    it('应更新阶段为 day_announce', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await resolveNightPhase(state);

      expect(result.currentPhase).toBe('day_announce');
    });
  });
});

describe('announceDayPhase - 白天公布节点', () => {
  it('应增加天数', async () => {
    const players = [createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' })];
    const state = createGameState({ gameId: 'test-game', players }, { currentDay: 1 });

    const result = await announceDayPhase(state);

    expect(result.currentDay).toBe(2);
  });

  it('应更新阶段为 speech', async () => {
    const players = [createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' })];
    const state = createGameState({ gameId: 'test-game', players });

    const result = await announceDayPhase(state);

    expect(result.currentPhase).toBe('speech');
  });
});

describe('checkWinNode - 胜负判定节点', () => {
  describe('好人胜利', () => {
    it('狼人全灭时好人应获胜', async () => {
      const players = [
        createPlayer('p1', 1, { role: 'villager' }),
        createPlayer('p2', 2, { role: 'seer' }),
        createPlayer('wolf', 3, { role: 'werewolf', faction: 'werewolf', isAlive: false }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await checkWinNode(state);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
      expect(result.currentPhase).toBe('check_win');
    });
  });

  describe('狼人胜利', () => {
    it('所有神职死亡时狼人应获胜（屠边）', async () => {
      const players = [
        createPlayer('villager', 1, { role: 'villager' }),
        createPlayer('seer', 2, { role: 'seer', isAlive: false }),
        createPlayer('witch', 3, { role: 'witch', isAlive: false }),
        createPlayer('wolf', 4, { role: 'werewolf', faction: 'werewolf' }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await checkWinNode(state);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
      expect(result.currentPhase).toBe('check_win');
    });

    it('所有平民死亡时狼人应获胜（屠边）', async () => {
      const players = [
        createPlayer('villager', 1, { role: 'villager', isAlive: false }),
        createPlayer('seer', 2, { role: 'seer' }),
        createPlayer('wolf', 3, { role: 'werewolf', faction: 'werewolf' }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await checkWinNode(state);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
      expect(result.currentPhase).toBe('check_win');
    });
  });

  describe('第三方胜利', () => {
    it('人狼恋情侣存活且场上仅剩他们时第三方应获胜', async () => {
      const players = [
        createPlayer('lover1', 1, { role: 'villager', isLover: true, loverId: 'lover2' }),
        createPlayer('lover2', 2, {
          role: 'werewolf',
          faction: 'werewolf',
          isLover: true,
          loverId: 'lover1',
        }),
      ];
      const state = createGameState(
        { gameId: 'test-game', players },
        {
          loverPair: ['lover1', 'lover2'],
        },
      );

      const result = await checkWinNode(state);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('third_party');
      expect(result.currentPhase).toBe('check_win');
    });
  });

  describe('游戏继续', () => {
    it('双方均存活时游戏应继续', async () => {
      const players = [
        createPlayer('p1', 1, { role: 'villager' }),
        createPlayer('p2', 2, { role: 'seer' }),
        createPlayer('wolf', 3, { role: 'werewolf', faction: 'werewolf' }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await checkWinNode(state);

      expect(result.isGameOver).toBe(false);
      expect(result.winner).toBeNull();
      expect(result.currentPhase).toBe('check_win');
    });
  });

  describe('阶段更新', () => {
    it('应更新阶段为 check_win', async () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
      ];
      const state = createGameState({ gameId: 'test-game', players });

      const result = await checkWinNode(state);

      expect(result.currentPhase).toBe('check_win');
    });
  });
});
