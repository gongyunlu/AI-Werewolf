import { checkSeerResult } from './seer-check';
import { createPlayer } from '../testing/test-utils';

describe('checkSeerResult - 预言家查验结果', () => {
  describe('普通狼人', () => {
    it('查验普通狼人应返回 werewolf', () => {
      const werewolf = createPlayer('p1', 1, {
        role: 'werewolf',
        faction: 'werewolf',
      });

      const result = checkSeerResult(werewolf);

      expect(result).toBe('werewolf');
    });

    it('查验狼王应返回 werewolf', () => {
      const wolfKing = createPlayer('p2', 2, {
        role: 'wolf_king',
        faction: 'werewolf',
      });

      const result = checkSeerResult(wolfKing);

      expect(result).toBe('werewolf');
    });

    it('查验白狼王应返回 werewolf', () => {
      const whiteWolf = createPlayer('p3', 3, {
        role: 'white_wolf',
        faction: 'werewolf',
      });

      const result = checkSeerResult(whiteWolf);

      expect(result).toBe('werewolf');
    });
  });

  describe('隐狼特殊处理', () => {
    it('查验隐狼应返回 good（伪装成好人）', () => {
      const hiddenWolf = createPlayer('p4', 4, {
        role: 'hidden_wolf',
        faction: 'werewolf',
      });

      const result = checkSeerResult(hiddenWolf);

      expect(result).toBe('good');
    });
  });

  describe('好人阵营', () => {
    it('查验平民应返回 good', () => {
      const villager = createPlayer('p5', 5, {
        role: 'villager',
        faction: 'villager',
      });

      const result = checkSeerResult(villager);

      expect(result).toBe('good');
    });

    it('查验预言家应返回 good', () => {
      const seer = createPlayer('p6', 6, {
        role: 'seer',
        faction: 'villager',
      });

      const result = checkSeerResult(seer);

      expect(result).toBe('good');
    });

    it('查验女巫应返回 good', () => {
      const witch = createPlayer('p7', 7, {
        role: 'witch',
        faction: 'villager',
      });

      const result = checkSeerResult(witch);

      expect(result).toBe('good');
    });

    it('查验猎人应返回 good', () => {
      const hunter = createPlayer('p8', 8, {
        role: 'hunter',
        faction: 'villager',
      });

      const result = checkSeerResult(hunter);

      expect(result).toBe('good');
    });

    it('查验守卫应返回 good', () => {
      const guard = createPlayer('p9', 9, {
        role: 'guard',
        faction: 'villager',
      });

      const result = checkSeerResult(guard);

      expect(result).toBe('good');
    });
  });

  describe('规则验证', () => {
    it('不应返回具体角色名，只返回阵营', () => {
      const seer = createPlayer('p10', 10, {
        role: 'seer',
        faction: 'villager',
      });

      const result = checkSeerResult(seer);

      // 验证只返回阵营信息，不泄露具体角色
      expect(result).toBe('good');
      expect(result).not.toBe('seer'); // 不应该返回具体角色
    });

    it('死亡玩家也可以被查验（返回阵营）', () => {
      const deadWerewolf = createPlayer('p11', 11, {
        role: 'werewolf',
        faction: 'werewolf',
        isAlive: false,
      });

      const result = checkSeerResult(deadWerewolf);

      expect(result).toBe('werewolf');
    });
  });
});
