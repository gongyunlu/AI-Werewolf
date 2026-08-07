import { resolveNightActions } from './night-resolution';
import type { PlayerState } from './types';

describe('resolveNightActions - 夜晚结算逻辑', () => {
  const createPlayer = (
    id: string,
    seatNumber: number,
    overrides?: Partial<PlayerState>,
  ): PlayerState => ({
    id,
    seatNumber,
    role: 'villager',
    faction: 'villager',
    isAlive: true,
    protectedByGuard: false,
    hasAntidoteUsed: false,
    hasPoisonUsed: false,
    ...overrides,
  });

  describe('狼刀击杀', () => {
    it('无守护无解药时应击杀成功', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({
        playerId: 'p1',
        cause: 'night_kill',
      });
    });

    it('狼人未选择目标时无人死亡', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
    });
  });

  describe('守卫守护', () => {
    it('守卫守护成功时应抵消狼刀', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: 'p1', // 守卫守护了 p1
        witchAntidoteTarget: null,
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
      expect(result.guardBlocked).toBe(true);
    });

    it('守卫守护其他人时不影响狼刀', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: 'p2', // 守卫守护了 p2，p1 仍被刀
        witchAntidoteTarget: null,
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0].playerId).toBe('p1');
      expect(result.guardBlocked).toBe(false);
    });
  });

  describe('女巫解药', () => {
    it('女巫解药成功时应抵消狼刀', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: null,
        witchAntidoteTarget: 'p1', // 女巫救了 p1
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
      expect(result.antidoteUsed).toBe(true);
    });

    it('女巫解药其他人时不影响狼刀', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: null,
        witchAntidoteTarget: 'p2', // 女巫救了 p2，但 p1 被刀
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0].playerId).toBe('p1');
      expect(result.antidoteUsed).toBe(true);
    });

    it('无人被刀时女巫解药无效', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: 'p1', // 女巫盲救
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
      expect(result.antidoteUsed).toBe(false); // 无效使用不消耗
    });
  });

  describe('守卫与女巫冲突', () => {
    it('守卫已守护时女巫解药无效（同守同救）', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: 'p1', // 守卫守护
        witchAntidoteTarget: 'p1', // 女巫也救（同守同救）
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({
        playerId: 'p1',
        cause: 'double_save', // 同守同救导致死亡
      });
      expect(result.guardBlocked).toBe(false); // 守卫失效
      expect(result.antidoteUsed).toBe(false); // 女巫药失效
      expect(result.isDoubleSave).toBe(true);
    });

    it('女巫救其他人时守卫生效', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: 'p1',
        witchAntidoteTarget: 'p2', // 女巫救了 p2
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0); // 守卫守护成功
      expect(result.guardBlocked).toBe(true);
      expect(result.isDoubleSave).toBe(false);
    });
  });

  describe('女巫毒药', () => {
    it('女巫毒药应独立生效', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: 'p2',
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({
        playerId: 'p2',
        cause: 'witch_poison',
      });
      expect(result.poisonUsed).toBe(true);
    });

    it('女巫同晚使用解药和毒药应抛出错误', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2), createPlayer('p3', 3)];

      expect(() =>
        resolveNightActions({
          players,
          wolfTarget: 'p1',
          guardTarget: null,
          witchAntidoteTarget: 'p1', // 救 p1
          witchPoisonTarget: 'p2', // 毒 p2（违反规则：同一晚只能用一种药）
        }),
      ).toThrow('女巫同一晚只能使用一种药');
    });

    it('女巫毒药和狼刀同一目标时双杀', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: 'p1', // 女巫和狼人都选了 p1
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0].playerId).toBe('p1');
      // 死因按优先级：毒 > 刀
      expect(result.deaths[0].cause).toBe('witch_poison');
      expect(result.poisonUsed).toBe(true);
    });
  });

  describe('复杂场景', () => {
    it('狼刀被守护，女巫毒另一人', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2), createPlayer('p3', 3)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: 'p1', // 守卫守护 p1
        witchAntidoteTarget: null,
        witchPoisonTarget: 'p2', // 女巫毒 p2
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({
        playerId: 'p2',
        cause: 'witch_poison',
      });
      expect(result.guardBlocked).toBe(true);
    });

    it('无任何行动时平安夜', () => {
      const players = [createPlayer('p1', 1), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
      expect(result.guardBlocked).toBe(false);
      expect(result.antidoteUsed).toBe(false);
      expect(result.poisonUsed).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('应忽略已死亡玩家的目标', () => {
      const players = [createPlayer('p1', 1, { isAlive: false }), createPlayer('p2', 2)];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1', // 刀已死亡的 p1
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: 'p1', // 毒已死亡的 p1
      });

      expect(result.deaths).toHaveLength(0);
    });
  });
});
