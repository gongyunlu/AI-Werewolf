import { resolveVotes } from './vote-resolution';
import { createPlayer } from '../testing/test-utils';

describe('resolveVotes - 计票逻辑', () => {
  // 辅助函数：快速构造 PlayerState

  describe('唯一最高票', () => {
    it('应返回票数最多的玩家', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
      ];
      // p2 获得 2 票，p3 获得 1 票
      const votes = new Map([
        ['p2', ['p1', 'p3']],
        ['p3', ['p2']],
      ]);

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBe('p2');
      expect(result.isTie).toBe(false);
      expect(result.tiedPlayerIds).toEqual([]);
    });

    it('应处理只有一票的情况', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      const votes = new Map([['p1', ['p2']]]);

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBe('p1');
      expect(result.isTie).toBe(false);
    });
  });

  describe('平票处理', () => {
    it('两人并列最高票时应返回平票', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p4', seatNo: 4, role: 'villager', faction: 'villager' }),
      ];
      // p1 和 p2 各获得 2 票
      const votes = new Map([
        ['p1', ['p3', 'p4']],
        ['p2', ['p1', 'p2']],
      ]);

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBeNull();
      expect(result.isTie).toBe(true);
      expect(result.tiedPlayerIds).toHaveLength(2);
      expect(result.tiedPlayerIds).toContain('p1');
      expect(result.tiedPlayerIds).toContain('p2');
    });

    it('三人并列最高票时应返回平票', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p3', seatNo: 3, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p4', seatNo: 4, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p5', seatNo: 5, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p6', seatNo: 6, role: 'villager', faction: 'villager' }),
      ];
      // p1、p2、p3 各获得 2 票
      const votes = new Map([
        ['p1', ['p4', 'p5']],
        ['p2', ['p6', 'p1']],
        ['p3', ['p2', 'p3']],
      ]);

      const result = resolveVotes(votes, players);

      expect(result.isTie).toBe(true);
      expect(result.tiedPlayerIds).toHaveLength(3);
      expect(result.tiedPlayerIds.toSorted()).toEqual(['p1', 'p2', 'p3']);
    });

    it('所有人票数相同时应返回平票', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      // 每人都获得 1 票
      const votes = new Map([
        ['p1', ['p2']],
        ['p2', ['p1']],
      ]);

      const result = resolveVotes(votes, players);

      expect(result.isTie).toBe(true);
      expect(result.tiedPlayerIds).toHaveLength(2);
    });
  });

  describe('特殊情况', () => {
    it('无人投票时应返回无人出局', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      const votes = new Map();

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBeNull();
      expect(result.isTie).toBe(false);
      expect(result.tiedPlayerIds).toEqual([]);
    });

    it('所有人弃权时应返回无人出局', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
        createPlayer({ id: 'p2', seatNo: 2, role: 'villager', faction: 'villager' }),
      ];
      // 空 Map 表示无有效投票
      const votes = new Map();

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBeNull();
      expect(result.isTie).toBe(false);
    });

    it('应忽略已死亡玩家的投票', () => {
      const players = [
        createPlayer('p1', 1, true),
        createPlayer('p2', 2, true),
        createPlayer('p3', 3, false), // 已死亡
      ];
      // p3 已死亡但其投票应被忽略
      const votes = new Map([
        ['p1', ['p2', 'p3']], // p3 的票应被忽略
        ['p2', ['p1']],
      ]);

      const result = resolveVotes(votes, players);

      // p1 实际只获得 p2 的 1 票，p2 获得 p1 的 1 票 → 平票
      expect(result.isTie).toBe(true);
    });

    it('应忽略投给已死亡玩家的票', () => {
      const players = [
        createPlayer('p1', 1, true),
        createPlayer('p2', 2, true),
        createPlayer('p3', 3, false), // 已死亡
      ];
      const votes = new Map([
        ['p3', ['p1', 'p2']], // 投给死人的票应被过滤
      ]);

      const result = resolveVotes(votes, players);

      // 没有有效投票
      expect(result.executedPlayerId).toBeNull();
      expect(result.isTie).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('应处理单人局', () => {
      const players = [
        createPlayer({ id: 'p1', seatNo: 1, role: 'villager', faction: 'villager' }),
      ];
      const votes = new Map([['p1', ['p1']]]);

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBe('p1');
    });

    it('应处理大局（12人）', () => {
      const players = Array.from({ length: 12 }, (_, i) => createPlayer(`p${i + 1}`, i + 1));
      // p1 获得 6 票，p2 获得 5 票
      const votes = new Map([
        ['p1', ['p3', 'p4', 'p5', 'p6', 'p7', 'p8']],
        ['p2', ['p9', 'p10', 'p11', 'p12', 'p1']],
      ]);

      const result = resolveVotes(votes, players);

      expect(result.executedPlayerId).toBe('p1');
      expect(result.isTie).toBe(false);
    });
  });
});
