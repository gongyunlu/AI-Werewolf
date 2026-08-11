import { resolveNightActions } from './night-resolution';
import { createPlayer } from '../testing/test-utils';

describe('resolveNightActions - 夜晚结算逻辑', () => {
  describe('狼刀击杀', () => {
    it('无守护无解药时应击杀成功', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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

    it('女巫解药其他人时解药消耗但狼刀生效', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveNightActions({
        players,
        wolfTarget: 'p1',
        guardTarget: null,
        witchAntidoteTarget: 'p2', // 女巫救了 p2，但 p1 被刀
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0].playerId).toBe('p1');
      expect(result.antidoteUsed).toBe(true); // 女巫使用了解药（即使救错人）
    });

    it('女巫不允许盲救（主工作流职责：无刀口时不询问女巫）', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      // 无人被刀，女巫解药目标为 null（主工作流不会询问女巫）
      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: null, // 主工作流不会在无刀口时询问女巫
        witchPoisonTarget: null,
      });

      expect(result.deaths).toHaveLength(0);
      expect(result.antidoteUsed).toBe(false); // 解药未使用
    });
  });

  describe('守卫与女巫冲突', () => {
    it('守卫已守护时女巫解药无效（同守同救）', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
      ];

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
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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

    it('女巫解药和毒药不能对同一人使用（解药在前）', () => {
      const witch = createPlayer('witch', 3, {
        role: 'witch',
        antidoteUsedOn: 'p1', // 之前对 p1 使用过解药
        hasAntidoteUsed: true,
      });
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        witch,
      ];

      expect(() =>
        resolveNightActions({
          players,
          wolfTarget: null,
          guardTarget: null,
          witchAntidoteTarget: null,
          witchPoisonTarget: 'p1', // 尝试对 p1 使用毒药
          witchPlayerId: 'witch',
        }),
      ).toThrow('女巫解药和毒药不能对同一人使用');
    });

    it('女巫解药和毒药不能对同一人使用（毒药在前）', () => {
      const witch = createPlayer('witch', 3, {
        role: 'witch',
        poisonUsedOn: 'p1', // 之前对 p1 使用过毒药
        hasPoisonUsed: true,
      });
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        witch,
      ];

      expect(() =>
        resolveNightActions({
          players,
          wolfTarget: 'p1',
          guardTarget: null,
          witchAntidoteTarget: 'p1', // 尝试对 p1 使用解药
          witchPoisonTarget: null,
          witchPlayerId: 'witch',
        }),
      ).toThrow('女巫解药和毒药不能对同一人使用');
    });

    it('女巫可以对不同的人分别使用解药和毒药', () => {
      const witch = createPlayer('witch', 3, {
        role: 'witch',
        antidoteUsedOn: 'p1', // 之前对 p1 使用过解药
        hasAntidoteUsed: true,
      });
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        witch,
      ];

      const result = resolveNightActions({
        players,
        wolfTarget: null,
        guardTarget: null,
        witchAntidoteTarget: null,
        witchPoisonTarget: 'p2', // 对 p2 使用毒药（不同于 p1）
        witchPlayerId: 'witch',
      });

      expect(result.deaths).toHaveLength(1);
      expect(result.deaths[0]).toEqual({
        playerId: 'p2',
        cause: 'witch_poison',
      });
    });
  });

  describe('边界情况', () => {
    it('应忽略已死亡玩家的目标', () => {
      const players = [
        createPlayer('p1', 1, { isAlive: false }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

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
