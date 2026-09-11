import type { PlayerState } from '../core/types';
import { FACTIONS, ROLES, type Faction } from '@ai-werewolf/shared';

export interface WinConditionResult {
  isGameOver: boolean;
  winner: Faction | null;
}

/**
 * 胜负判定（屠边规则 + 人狼恋）
 *
 * 说明：
 * - **神职**：role !== 'villager' 且 faction === 'villager' 的角色
 * - **平民**：role === 'villager' 且 faction === 'villager' 的角色
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

  for (const p of players) {
    if (!p.isAlive) continue;

    alive.push(p);

    if (p.faction === FACTIONS.WEREWOLF) {
      aliveWerewolves.push(p);
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

  // 绑票不构成终局，继续投票和技能结算。
  // === 条件3：狼人屠边胜利 ===
  // 所有神职死亡 OR 所有平民死亡
  if (aliveGods.length === 0 || aliveVillagers.length === 0) {
    return { isGameOver: true, winner: FACTIONS.WEREWOLF };
  }

  // === 条件4：游戏继续 ===
  return { isGameOver: false, winner: null };
}
