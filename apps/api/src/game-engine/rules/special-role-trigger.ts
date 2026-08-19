import type { PlayerState } from '../core/types';
import type { DeathCause } from '@ai-werewolf/shared';
import { ROLES } from '@ai-werewolf/shared';

export interface SpecialRoleTriggerInput {
  players: PlayerState[];
  executedPlayerId: string | null; // 本次死亡的玩家 ID
  executedCause: DeathCause | null;
}

export interface SpecialRoleTriggerResult {
  hunterCanShoot: boolean;
  hunterPlayerId: string | null;
  wolfKingCanShoot: boolean;
  wolfKingPlayerId: string | null;
  whiteWolfCanKill: boolean; // 白狼王自爆是否可以带走一人
  whiteWolfPlayerId: string | null;
  idiotRevealed: boolean; // 白痴是否翻牌
  idiotPlayerId: string | null;
  idiotSurvives: boolean;
}

/**
 * 特殊角色触发逻辑：猎人开枪、狼王开枪、白痴翻牌
 *
 * 规则：
 * - 猎人：被放逐或夜晚被刀死时可以开枪，被毒死或同守同救时不能开枪
 * - 狼王：仅被放逐时可以开枪，其他死法不能开枪
 * - 白痴：仅被放逐时翻牌免疫死亡，其他死法正常死亡
 */
export function resolveSpecialRoleTriggers(
  input: SpecialRoleTriggerInput,
): SpecialRoleTriggerResult {
  const { players, executedPlayerId, executedCause } = input;

  const result: SpecialRoleTriggerResult = {
    hunterCanShoot: false,
    hunterPlayerId: null,
    wolfKingCanShoot: false,
    wolfKingPlayerId: null,
    whiteWolfCanKill: false,
    whiteWolfPlayerId: null,
    idiotRevealed: false,
    idiotPlayerId: null,
    idiotSurvives: false,
  };

  // 无人死亡
  if (!executedPlayerId || !executedCause) {
    return result;
  }

  // 找到死亡玩家（触发死亡技能时该玩家已被标记死亡，不能校验 isAlive）
  const executedPlayer = players.find((p) => p.id === executedPlayerId);
  if (!executedPlayer) {
    return result;
  }

  // 猎人开枪：被放逐或夜晚被刀死时触发，但被毒、同守同救、被狼美人魅惑时不能开枪
  if (executedPlayer.role === ROLES.HUNTER) {
    const cannotShoot = ['witch_poison', 'double_save', 'wolf_beauty_charm'];
    const canShoot = !cannotShoot.includes(executedCause);
    if (canShoot) {
      result.hunterCanShoot = true;
      result.hunterPlayerId = executedPlayerId;
    }
  }

  // 狼王开枪：可以开枪的情况 - 被放逐、被刀、被猎人射杀
  // 不能开枪的情况 - 自爆、被毒、殉情
  if (executedPlayer.role === ROLES.WOLF_KING) {
    const cannotShoot = ['witch_poison', 'self_destruct', 'love_death'];
    const canShoot = !cannotShoot.includes(executedCause);
    if (canShoot) {
      result.wolfKingCanShoot = true;
      result.wolfKingPlayerId = executedPlayerId;
    }
  }

  // 白狼王自爆：自爆后可以带走一名玩家（核心技能）
  if (executedPlayer.role === ROLES.WHITE_WOLF) {
    if (executedCause === 'self_destruct') {
      result.whiteWolfCanKill = true;
      result.whiteWolfPlayerId = executedPlayerId;
    }
  }

  // 白痴翻牌：仅被放逐时触发，免疫死亡
  if (executedPlayer.role === ROLES.IDIOT) {
    if (executedCause === 'execution') {
      result.idiotRevealed = true;
      result.idiotPlayerId = executedPlayerId;
      result.idiotSurvives = true;
    }
  }

  return result;
}
