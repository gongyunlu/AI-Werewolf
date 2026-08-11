import { checkWinCondition } from './win-condition';
import { createPlayer } from '../testing/test-utils';
import type { PlayerState } from '../core/types';

describe('checkWinCondition - 胜负判定（屠边规则 + 人狼恋 + 拍刀）', () => {
  // 辅助函数：快速构造 PlayerState

  describe('第三方胜利（人狼恋）- 最高优先级', () => {
    it('人狼恋情侣存活且其他全灭时，第三方胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true), // 狼人（情侣）
        createPlayer('v1', 2, 'villager', 'villager', true), // 平民（情侣）
        createPlayer('s1', 3, 'seer', 'villager', false),
        createPlayer('w2', 4, 'werewolf', 'werewolf', false),
      ];

      const result = checkWinCondition(players, ['w1', 'v1']);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('third_party');
    });

    it('人狼恋情侣存活，但有第三人存活时，游戏继续', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true), // 狼人（情侣）
        createPlayer('v1', 2, 'villager', 'villager', true), // 平民（情侣）
        createPlayer('s1', 3, 'seer', 'villager', true), // 第三人
      ];

      const result = checkWinCondition(players, ['w1', 'v1']);

      expect(result.isGameOver).toBe(false);
      expect(result.winner).toBeNull();
    });

    it('情侣其中一方死亡时，不触发第三方胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false), // 狼人（情侣，已死）
        createPlayer('v1', 2, 'villager', 'villager', true), // 平民（情侣）
        createPlayer('w2', 3, 'werewolf', 'werewolf', false),
      ];

      const result = checkWinCondition(players, ['w1', 'v1']);

      // 狼人全灭 → 好人胜利
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('同阵营情侣（双好人）不触发第三方胜利', () => {
      const players = [
        createPlayer('v1', 1, 'villager', 'villager', true),
        createPlayer('s1', 2, 'seer', 'villager', true),
        createPlayer('w1', 3, 'werewolf', 'werewolf', false),
      ];

      const result = checkWinCondition(players, ['v1', 's1']);

      // 狼人全灭 → 好人胜利
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });
  });

  describe('好人胜利条件：狼人全灭', () => {
    it('狼人全部出局时，好人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('w2', 2, 'werewolf', 'werewolf', false),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('s1', 4, 'seer', 'villager', true),
        createPlayer('w3', 5, 'witch', 'villager', true),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('只剩一个神职但狼人已全灭时，好人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('w2', 2, 'werewolf', 'werewolf', false),
        createPlayer('w3', 3, 'werewolf', 'werewolf', false),
        createPlayer('s1', 4, 'seer', 'villager', true),
        createPlayer('v1', 5, 'villager', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('只剩一个平民但狼人已全灭时，好人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('w2', 2, 'werewolf', 'werewolf', false),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('s1', 4, 'seer', 'villager', false),
        createPlayer('w3', 5, 'witch', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });
  });

  describe('狼人拍刀速胜', () => {
    it('2主刀狼 vs 2好人，触发拍刀（狼人数 = 好人数）', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('s1', 4, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players, null);

      // 2狼 = 2好人，满足拍刀条件（≤）
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('3主刀狼 vs 2好人，触发拍刀', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'wolf_king', 'werewolf', true),
        createPlayer('w3', 3, 'white_wolf', 'werewolf', true),
        createPlayer('v1', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('仅剩隐狼和2好人，不触发拍刀（隐狼无刀）', () => {
      const players = [
        createPlayer('h1', 1, 'hidden_wolf', 'werewolf', true),
        createPlayer('v1', 2, 'villager', 'villager', true),
        createPlayer('s1', 3, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players, null);

      // 隐狼不能刀，且神民都存活，狼人未达到屠边条件
      expect(result.isGameOver).toBe(false);
    });

    it('仅剩隐狼和1好人（主刀狼已死），触发拍刀（隐狼获得刀人能力）', () => {
      const players = [
        createPlayer('h1', 1, 'hidden_wolf', 'werewolf', true),
        createPlayer('v1', 2, 'villager', 'villager', true),
        createPlayer('w1', 3, 'werewolf', 'werewolf', false),
        createPlayer('s1', 4, 'seer', 'villager', false),
      ];

      // 此时存活：1隐狼 vs 1好人，隐狼获得刀人能力，可以拍刀
      const result = checkWinCondition(players, null);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('石像鬼单独存活 vs 1好人，触发拍刀', () => {
      const players = [
        createPlayer('g1', 1, 'stone_wolf', 'werewolf', true),
        createPlayer('v1', 2, 'villager', 'villager', true),
        createPlayer('w1', 3, 'werewolf', 'werewolf', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('1主刀狼 + 1隐狼 vs 2好人，不触发拍刀（只计算主刀狼）', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('h1', 2, 'hidden_wolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('s1', 4, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players);

      // 1主刀狼 < 2好人，不满足拍刀条件
      expect(result.isGameOver).toBe(false);
    });

    it('有第三方存在时不触发拍刀', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('w3', 3, 'werewolf', 'werewolf', true),
        createPlayer('v1', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', true),
        createPlayer('c1', 6, 'cupid', 'third_party', true),
      ];

      const result = checkWinCondition(players);

      // 有第三方干扰，不触发拍刀
      expect(result.isGameOver).toBe(false);
    });
  });

  describe('狼人屠边胜利', () => {
    it('所有神职死亡时，狼人胜利（即使平民还活着）', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('v2', 4, 'villager', 'villager', true),
        createPlayer('v3', 5, 'villager', 'villager', true),
        createPlayer('s1', 6, 'seer', 'villager', false),
        createPlayer('w3', 7, 'witch', 'villager', false),
        createPlayer('h1', 8, 'hunter', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('所有平民死亡时，狼人胜利（即使神职还活着）', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', false),
        createPlayer('v2', 4, 'villager', 'villager', false),
        createPlayer('v3', 5, 'villager', 'villager', false),
        createPlayer('s1', 6, 'seer', 'villager', true),
        createPlayer('w3', 7, 'witch', 'villager', true),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('神职和平民都全灭时，狼人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', false),
        createPlayer('s1', 4, 'seer', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });
  });

  describe('游戏未结束', () => {
    it('狼人、神职、平民都有存活时，游戏继续', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('v2', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(false);
      expect(result.winner).toBeNull();
    });

    it('经典12人局（3狼9好人）开局未结束', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('w3', 3, 'werewolf', 'werewolf', true),
        createPlayer('s1', 4, 'seer', 'villager', true),
        createPlayer('wi1', 5, 'witch', 'villager', true),
        createPlayer('h1', 6, 'hunter', 'villager', true),
        ...Array.from({ length: 6 }, (_, i) =>
          createPlayer(`v${i + 1}`, i + 7, 'villager', 'villager', true),
        ),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(false);
      expect(result.winner).toBeNull();
    });

    it('6狼6好人开局触发拍刀', () => {
      const players = [
        ...Array.from({ length: 6 }, (_, i) =>
          createPlayer(`w${i + 1}`, i + 1, 'werewolf', 'werewolf', true),
        ),
        createPlayer('s1', 7, 'seer', 'villager', true),
        createPlayer('wi1', 8, 'witch', 'villager', true),
        ...Array.from({ length: 4 }, (_, i) =>
          createPlayer(`v${i + 1}`, i + 9, 'villager', 'villager', true),
        ),
      ];

      const result = checkWinCondition(players);

      // 6狼 = 6好人，满足拍刀条件
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });
  });

  describe('边界情况', () => {
    it('只有狼人和神职存活（无平民），狼人屠边胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('s1', 3, 'seer', 'villager', true),
        createPlayer('wi1', 4, 'witch', 'villager', true),
        createPlayer('v1', 5, 'villager', 'villager', false),
        createPlayer('v2', 6, 'villager', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('只有狼人和平民存活（无神职），狼人屠边胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('v2', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', false),
        createPlayer('wi1', 6, 'witch', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('只有神职存活（无平民无狼人），好人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('w2', 2, 'werewolf', 'werewolf', false),
        createPlayer('s1', 3, 'seer', 'villager', true),
        createPlayer('wi1', 4, 'witch', 'villager', true),
        createPlayer('v1', 5, 'villager', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('只有平民存活（无神职无狼人），好人胜利', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('w2', 2, 'werewolf', 'werewolf', false),
        createPlayer('v1', 3, 'villager', 'villager', true),
        createPlayer('v2', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('所有玩家阵亡时，好人胜利（狼人=0优先判定）', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('v1', 2, 'villager', 'villager', false),
        createPlayer('s1', 3, 'seer', 'villager', false),
      ];

      const result = checkWinCondition(players);

      // 条件1：狼人=0 → 好人胜
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('villager');
    });

    it('空玩家列表应返回未结束（防御性代码）', () => {
      const players: PlayerState[] = [];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(false);
      expect(result.winner).toBeNull();
    });

    it('板子没有平民（纯神职局），神职全灭时狼人胜', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('s1', 3, 'seer', 'villager', false),
        createPlayer('wi1', 4, 'witch', 'villager', false),
        createPlayer('h1', 5, 'hunter', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('板子没有神职（纯平民局），平民全灭时狼人胜', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('v1', 3, 'villager', 'villager', false),
        createPlayer('v2', 4, 'villager', 'villager', false),
        createPlayer('v3', 5, 'villager', 'villager', false),
      ];

      const result = checkWinCondition(players);

      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });
  });

  describe('判定优先级验证', () => {
    it('第三方胜利优先于好人胜利', () => {
      // 构造：人狼恋存活 + 其他狼人已死
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true), // 情侣狼
        createPlayer('v1', 2, 'villager', 'villager', true), // 情侣好人
        createPlayer('w2', 3, 'werewolf', 'werewolf', false),
      ];

      const result = checkWinCondition(players, ['w1', 'v1']);

      // 应触发第三方胜利而不是好人胜利（虽然只剩1狼）
      expect(result.winner).toBe('third_party');
    });

    it('好人胜利优先于拍刀判定', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', false),
        createPlayer('v1', 2, 'villager', 'villager', true),
        createPlayer('s1', 3, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players);

      // 狼人全灭 → 好人胜，不会判定拍刀
      expect(result.winner).toBe('villager');
    });

    it('拍刀判定优先于屠边判定', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('w2', 2, 'werewolf', 'werewolf', true),
        createPlayer('w3', 3, 'werewolf', 'werewolf', true),
        createPlayer('v1', 4, 'villager', 'villager', true),
        createPlayer('s1', 5, 'seer', 'villager', false),
        createPlayer('wi1', 6, 'witch', 'villager', false),
      ];

      const result = checkWinCondition(players);

      // 3狼 > 1平民（神职已死），应触发拍刀而非屠边
      expect(result.isGameOver).toBe(true);
      expect(result.winner).toBe('werewolf');
    });

    it('只有屠边条件不满足时游戏才继续', () => {
      const players = [
        createPlayer('w1', 1, 'werewolf', 'werewolf', true),
        createPlayer('v1', 2, 'villager', 'villager', true),
        createPlayer('v2', 3, 'villager', 'villager', true),
        createPlayer('s1', 4, 'seer', 'villager', true),
      ];

      const result = checkWinCondition(players);

      // 狼人存活 + 神职和平民都存活 + 未触发拍刀 → 游戏继续
      expect(result.isGameOver).toBe(false);
    });
  });
});
