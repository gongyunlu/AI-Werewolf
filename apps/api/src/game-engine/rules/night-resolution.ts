import type { PlayerState } from '../core/types';
import type { DeathCause } from '@ai-werewolf/shared';
import { ROLES } from '@ai-werewolf/shared';

export interface NightActionInput {
  players: PlayerState[];
  wolfTarget: string | null;
  guardTarget: string | null;
  witchAntidoteTarget: string | null;
  witchPoisonTarget: string | null;
}

export interface NightDeathRecord {
  playerId: string;
  cause: DeathCause;
}

export interface NightResolutionResult {
  deaths: NightDeathRecord[];
  guardBlocked: boolean; // 守卫是否成功守护
  antidoteUsed: boolean; // 女巫解药是否生效（成功救人）
  poisonUsed: boolean;
  isDoubleSave: boolean; // 是否同守同救
}

/**
 * 夜晚结算逻辑：守卫守护抵消刀人、女巫解药抵消刀人、毒药生效的优先级
 *
 * 规则：
 * 1. 狼刀 + 守卫守护同一目标 → 守护成功，目标存活
 * 2. 狼刀 + 女巫解药同一目标 → 解药成功，目标存活
 * 3. 狼刀 + 守卫守护 + 女巫解药同一目标 → 同守同救，目标死亡（double_save）
 * 4. 女巫毒药独立生效，不受守卫/解药影响
 * 5. 同一目标被多种方式击杀时，死因按优先级：毒药 > 狼刀
 * 6. 已死亡玩家不能成为目标
 * 7. 女巫同一晚只能用一种药（解药 OR 毒药）
 * 8. 女巫永远不能自救；可以在后续夜晚毒此前救过的目标
 */
export function resolveNightActions(input: NightActionInput): NightResolutionResult {
  const { players, wolfTarget, guardTarget, witchAntidoteTarget, witchPoisonTarget } = input;

  // 校验：女巫同一晚只能用一种药
  if (witchAntidoteTarget !== null && witchPoisonTarget !== null) {
    throw new Error('女巫同一晚只能使用一种药（解药 OR 毒药）');
  }

  // 校验：女巫不能自救（统一规则，所有板子所有场景）
  if (witchAntidoteTarget !== null) {
    const witchPlayer = players.find((p) => p.role === ROLES.WITCH);
    if (witchPlayer && witchAntidoteTarget === witchPlayer.id) {
      throw new Error('女巫不能自救（统一规则）');
    }
  }

  const alivePlayerIds = new Set(players.filter((p) => p.isAlive).map((p) => p.id));
  const deaths: NightDeathRecord[] = [];

  let guardBlocked = false;
  let antidoteUsed = false;
  let poisonUsed = false;
  let isDoubleSave = false;

  // 处理狼刀
  if (wolfTarget && alivePlayerIds.has(wolfTarget)) {
    const isGuarded = guardTarget === wolfTarget;
    const isSaved = witchAntidoteTarget === wolfTarget;

    // 同守同救 → 目标死亡
    if (isGuarded && isSaved) {
      deaths.push({ playerId: wolfTarget, cause: 'double_save' });
      isDoubleSave = true;
      // 守卫和解药都失效，不设置 guardBlocked/antidoteUsed
    }
    // 仅守卫守护 → 目标存活
    else if (isGuarded) {
      guardBlocked = true;
    }
    // 仅女巫解药 → 目标存活
    else if (isSaved) {
      antidoteUsed = true;
    }
    // 无守护无解药 → 目标死亡
    else {
      deaths.push({ playerId: wolfTarget, cause: 'night_kill' });
    }
  }

  // 女巫使用了解药但救错人（目标不是刀口） → 标记解药已使用
  if (
    witchAntidoteTarget !== null &&
    alivePlayerIds.has(witchAntidoteTarget) &&
    witchAntidoteTarget !== wolfTarget &&
    !isDoubleSave
  ) {
    antidoteUsed = true;
  }

  // 女巫毒药：独立生效
  if (witchPoisonTarget && alivePlayerIds.has(witchPoisonTarget)) {
    poisonUsed = true;
    // 如果目标已被狼刀杀死，替换死因为毒药（优先级更高）
    const existingDeathIndex = deaths.findIndex((d) => d.playerId === witchPoisonTarget);
    if (existingDeathIndex >= 0) {
      deaths[existingDeathIndex].cause = 'witch_poison';
    } else {
      deaths.push({ playerId: witchPoisonTarget, cause: 'witch_poison' });
    }
  }

  return {
    deaths,
    guardBlocked,
    antidoteUsed,
    poisonUsed,
    isDoubleSave,
  };
}
