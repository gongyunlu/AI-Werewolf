import type { PlayerState } from './types';
import type { Faction, Role } from '@ai-werewolf/shared';

export interface WinConditionResult {
  isGameOver: boolean;
  winner: Faction | null;
}

/**
 * 具备夜间刀人能力的狼人角色（主刀狼）
 */
const KNIFE_CAPABLE_WOLVES = new Set<Role>(['werewolf', 'wolf_king', 'white_wolf', 'wolf_beauty']);

/**
 * 不具备夜间刀人能力的狼人角色（隐狼/石像鬼等）
 */
const NON_KNIFE_WOLVES = new Set<Role>(['hidden_wolf', 'stone_wolf']);

/**
 * 胜负判定（标准狼人杀规则 + 人狼恋 + 拍刀速胜）
 *
 * 判定顺序（由高到低）：
 * 1. **第三方胜利（人狼恋）**：存在一对跨阵营情侣，且仅他们存活（总存活 = 2）
 * 2. **好人胜利**：狼人全灭
 * 3. **狼人拍刀速胜**：具备刀人能力的狼数 >= 存活好人数（且无第三方干扰）
 * 4. **狼人屠边胜利**：所有神职死亡 OR 所有平民死亡
 * 5. 否则游戏继续
 *
 * 说明：
 * - **神职**：role !== 'villager' 且 faction === 'villager' 的角色
 * - **平民**：role === 'villager' 且 faction === 'villager' 的角色
 * - **拍刀能力**：默认具备刀人能力的狼包括 werewolf/wolf_king/white_wolf/wolf_beauty
 *   - 特殊规则：若场上不存在任何主刀狼，则隐狼/石像鬼获得刀人能力
 *
 * @param players 当前所有玩家状态
 * @param loverPair 情侣对（可选，格式为 [playerId1, playerId2]）
 * @returns 是否结束 + 获胜阵营
 */
export function checkWinCondition(
  players: PlayerState[],
  loverPair?: string[] | null,
): WinConditionResult {
  // 防御性代码：空列表直接返回未结束
  if (players.length === 0) {
    return { isGameOver: false, winner: null };
  }

  // 统计存活玩家
  const alive = players.filter((p) => p.isAlive);
  const aliveWerewolves = alive.filter((p) => p.faction === 'werewolf');
  const aliveGods = alive.filter((p) => p.faction === 'villager' && p.role !== 'villager');
  const aliveVillagers = alive.filter((p) => p.faction === 'villager' && p.role === 'villager');
  const aliveThirdParty = alive.filter((p) => p.faction === 'third_party');

  // === 条件1：第三方胜利（人狼恋）===
  if (loverPair && loverPair.length === 2) {
    const [lover1Id, lover2Id] = loverPair;
    const lover1 = alive.find((p) => p.id === lover1Id);
    const lover2 = alive.find((p) => p.id === lover2Id);

    // 情侣均存活 + 总存活数为2 + 跨阵营（一狼一好人）
    if (lover1 && lover2 && alive.length === 2) {
      const factions = [lover1.faction, lover2.faction].toSorted();
      if (factions[0] === 'villager' && factions[1] === 'werewolf') {
        return { isGameOver: true, winner: 'third_party' };
      }
    }
  }

  // === 条件2：好人胜利（狼人全灭）===
  if (aliveWerewolves.length === 0) {
    return { isGameOver: true, winner: 'villager' };
  }

  // === 条件3：狼人拍刀速胜 ===
  // 前提：无第三方干扰（仅狼人 vs 好人）
  if (aliveThirdParty.length === 0) {
    const aliveGoodCount = aliveGods.length + aliveVillagers.length;

    // 统计具备刀人能力的狼
    const mainKnifeWolves = aliveWerewolves.filter((w) => KNIFE_CAPABLE_WOLVES.has(w.role));
    const nonKnifeWolves = aliveWerewolves.filter((w) => NON_KNIFE_WOLVES.has(w.role));

    let knifeCapableCount = mainKnifeWolves.length;

    // 特殊规则：若无主刀狼，隐狼/石像鬼获得刀人能力
    if (mainKnifeWolves.length === 0 && nonKnifeWolves.length > 0) {
      knifeCapableCount = nonKnifeWolves.length;
    }

    // 拍刀判定：具备刀人能力的狼数 > 好人数（严格大于，确保狼人有压倒性优势）
    if (knifeCapableCount > aliveGoodCount) {
      return { isGameOver: true, winner: 'werewolf' };
    }
  }

  // === 条件4：狼人屠边胜利 ===
  // 所有神职死亡 OR 所有平民死亡
  if (aliveGods.length === 0 || aliveVillagers.length === 0) {
    return { isGameOver: true, winner: 'werewolf' };
  }

  // === 条件5：游戏继续 ===
  return { isGameOver: false, winner: null };
}
