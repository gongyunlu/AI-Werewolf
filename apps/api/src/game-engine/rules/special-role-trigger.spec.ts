import { resolveSpecialRoleTriggers } from './special-role-trigger';
import { createPlayer } from '../testing/test-utils';

describe('resolveSpecialRoleTriggers - 特殊角色触发逻辑', () => {
  describe('猎人开枪', () => {
    it('猎人被放逐时应触发开枪', () => {
      const hunter = createPlayer('p1', 1, { role: 'hunter', faction: 'villager' });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      expect(result.hunterCanShoot).toBe(true);
      expect(result.hunterPlayerId).toBe('p1');
    });

    it('猎人夜晚被刀死时应触发开枪', () => {
      const hunter = createPlayer('p1', 1, { role: 'hunter', faction: 'villager' });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'night_kill',
      });

      expect(result.hunterCanShoot).toBe(true);
      expect(result.hunterPlayerId).toBe('p1');
    });

    it('猎人被女巫毒死时不能开枪', () => {
      const hunter = createPlayer('p1', 1, { role: 'hunter', faction: 'villager' });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'witch_poison',
      });

      expect(result.hunterCanShoot).toBe(false);
      expect(result.hunterPlayerId).toBeNull();
    });

    it('非猎人被放逐时不触发开枪', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      expect(result.hunterCanShoot).toBe(false);
      expect(result.hunterPlayerId).toBeNull();
    });
  });

  describe('狼王开枪', () => {
    it('狼王被放逐时应触发开枪', () => {
      const wolfKing = createPlayer('p1', 1, { role: 'wolf_king', faction: 'werewolf' });
      const players = [
        wolfKing,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      expect(result.wolfKingCanShoot).toBe(true);
      expect(result.wolfKingPlayerId).toBe('p1');
    });

    it('狼王被狼刀时可以开枪', () => {
      const wolfKing = createPlayer('p1', 1, { role: 'wolf_king', faction: 'werewolf' });
      const players = [
        wolfKing,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'night_kill',
      });

      expect(result.wolfKingCanShoot).toBe(true);
      expect(result.wolfKingPlayerId).toBe('p1');
    });

    it('狼王被女巫毒死时不能开枪', () => {
      const wolfKing = createPlayer('p1', 1, { role: 'wolf_king', faction: 'werewolf' });
      const players = [
        wolfKing,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'witch_poison',
      });

      expect(result.wolfKingCanShoot).toBe(false);
    });
  });

  describe('白痴翻牌', () => {
    it('白痴被放逐时应翻牌免疫', () => {
      const idiot = createPlayer('p1', 1, { role: 'idiot', faction: 'villager' });
      const players = [
        idiot,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      expect(result.idiotRevealed).toBe(true);
      expect(result.idiotPlayerId).toBe('p1');
      expect(result.idiotSurvives).toBe(true);
    });

    it('白痴夜晚被刀死时不翻牌', () => {
      const idiot = createPlayer('p1', 1, { role: 'idiot', faction: 'villager' });
      const players = [
        idiot,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'night_kill',
      });

      expect(result.idiotRevealed).toBe(false);
      expect(result.idiotPlayerId).toBeNull();
      expect(result.idiotSurvives).toBe(false);
    });

    it('非白痴被放逐时不翻牌', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      expect(result.idiotRevealed).toBe(false);
      expect(result.idiotSurvives).toBe(false);
    });
  });

  describe('多角色同时触发', () => {
    it('猎人和狼王不能同时存在于同一玩家', () => {
      // 这是逻辑约束测试，实际不可能出现
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      // 正常情况应该只触发一个
      const triggerCount = [
        result.hunterCanShoot,
        result.wolfKingCanShoot,
        result.idiotRevealed,
      ].filter(Boolean).length;

      expect(triggerCount).toBeLessThanOrEqual(1);
    });
  });

  describe('边界情况', () => {
    it('无人死亡时不触发任何特殊角色', () => {
      const hunter = createPlayer('p1', 1, { role: 'hunter', faction: 'villager' });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: null,
        executedCause: null,
      });

      expect(result.hunterCanShoot).toBe(false);
      expect(result.wolfKingCanShoot).toBe(false);
      expect(result.idiotRevealed).toBe(false);
    });

    it('已死亡玩家不触发特殊角色', () => {
      const hunter = createPlayer('p1', 1, {
        role: 'hunter',
        faction: 'villager',
        isAlive: false,
      });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'execution',
      });

      // 已死亡的猎人不能再开枪
      expect(result.hunterCanShoot).toBe(false);
    });
  });

  describe('同守同救死亡', () => {
    it('猎人同守同救死亡时不能开枪', () => {
      const hunter = createPlayer('p1', 1, { role: 'hunter', faction: 'villager' });
      const players = [
        hunter,
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];

      const result = resolveSpecialRoleTriggers({
        players,
        executedPlayerId: 'p1',
        executedCause: 'double_save',
      });

      expect(result.hunterCanShoot).toBe(false);
    });
  });
});
