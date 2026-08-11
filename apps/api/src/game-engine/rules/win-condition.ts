import type { PlayerState } from '../core/types';
import { FACTIONS, ROLES, type Faction, type Role } from '@ai-werewolf/shared';

export interface WinConditionResult {
  isGameOver: boolean;
  winner: Faction | null;
}

/**
 * 具备夜间刀人能力的狼人角色（主刀狼）
 */
const KNIFE_CAPABLE_WOLVES = new Set<Role>([
  ROLES.WEREWOLF, // 狼人
  ROLES.WOLF_KING, // 狼王
  ROLES.WHITE_WOLF, // 白狼王
  ROLES.WOLF_BEAUTY, // 狼美人
]);

/**
 * 不具备夜间刀人能力的狼人角色（隐狼/石像鬼等）
 */
const NON_KNIFE_WOLVES = new Set<Role>([
  ROLES.HIDDEN_WOLF, // 隐狼
  ROLES.STONE_WOLF, // 石像鬼
]);

/**
 * 胜负判定（标准狼人杀规则 + 人狼恋 + 拍刀速胜）
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
  // 空列表直接返回未结束
  if (players.length === 0) {
    return { isGameOver: false, winner: null };
  }

  // 统计存活玩家
  const alive: PlayerState[] = [];
  const aliveWerewolves: PlayerState[] = [];
  const aliveGods: PlayerState[] = [];
  const aliveVillagers: PlayerState[] = [];
  const aliveThirdParty: PlayerState[] = [];

  for (const p of players) {
    if (!p.isAlive) continue;

    alive.push(p);

    if (p.faction === FACTIONS.WEREWOLF) {
      aliveWerewolves.push(p);
    } else if (p.faction === FACTIONS.THIRD_PARTY) {
      aliveThirdParty.push(p);
    } else if (p.faction === FACTIONS.VILLAGER) {
      if (p.role === ROLES.VILLAGER) {
        aliveVillagers.push(p);
      } else {
        aliveGods.push(p);
      }
    }
  }

  // === 条件1：第三方胜利（人狼恋）===
  if (loverPair && loverPair.length === 2) {
    const [lover1Id, lover2Id] = loverPair;
    const lover1 = alive.find((p) => p.id === lover1Id);
    const lover2 = alive.find((p) => p.id === lover2Id);

    // 情侣均存活 + 跨阵营（一狼一好人）+ 场上只剩第三方阵营
    if (lover1 && lover2) {
      const factions = [lover1.faction, lover2.faction].toSorted();
      const isCrossFaction = factions[0] === FACTIONS.VILLAGER && factions[1] === FACTIONS.WEREWOLF;

      if (isCrossFaction) {
        // 检查是否所有非第三方玩家均已出局
        const nonThirdPartyAlive = alive.filter(
          (p) => p.faction !== FACTIONS.THIRD_PARTY && p.id !== lover1Id && p.id !== lover2Id,
        );

        if (nonThirdPartyAlive.length === 0) {
          return { isGameOver: true, winner: FACTIONS.THIRD_PARTY };
        }
      }
    }
  }

  // === 条件2：好人胜利（狼人全灭）===
  if (aliveWerewolves.length === 0) {
    return { isGameOver: true, winner: FACTIONS.VILLAGER };
  }

  // === 条件3：狼人拍刀速胜 ===
  // 前提：无第三方干扰（仅狼人 vs 好人）
  if (aliveThirdParty.length === 0) {
    const aliveGoodCount = aliveGods.length + aliveVillagers.length;

    // 统计具备刀人能力的狼
    const mainKnifeWolves = aliveWerewolves.filter((w) => KNIFE_CAPABLE_WOLVES.has(w.role));
    const nonKnifeWolves = aliveWerewolves.filter((w) => NON_KNIFE_WOLVES.has(w.role));

    let knifeCapableCount = mainKnifeWolves.length;

    // 特殊规则：若无存活主刀狼，隐狼/石像鬼获得刀人能力
    // 场景1：曾经存在主刀狼但现在全死了
    // 场景2：开局就没有主刀狼（纯隐狼/石像鬼配置）
    if (mainKnifeWolves.length === 0 && nonKnifeWolves.length > 0) {
      knifeCapableCount = nonKnifeWolves.length;
    }

    // 拍刀判定：具备刀人能力的狼数 >= 好人数
    if (knifeCapableCount >= aliveGoodCount) {
      return { isGameOver: true, winner: FACTIONS.WEREWOLF };
    }
  }

  // === 条件4：狼人屠边胜利 ===
  // 所有神职死亡 OR 所有平民死亡
  if (aliveGods.length === 0 || aliveVillagers.length === 0) {
    return { isGameOver: true, winner: FACTIONS.WEREWOLF };
  }

  // === 条件5：游戏继续 ===
  return { isGameOver: false, winner: null };
}
