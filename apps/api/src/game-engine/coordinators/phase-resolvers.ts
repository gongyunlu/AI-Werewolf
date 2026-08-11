import type { GameGraphState } from '../core/types';
import { resolveNightActions } from '../rules/night-resolution';
import { checkSeerResult } from '../rules/seer-check';
import { checkWinCondition } from '../rules/win-condition';
import { ROLES } from '@ai-werewolf/shared';

/**
 * 夜间结算节点
 *
 * 1. 收集夜间行动结果（狼刀、预言家查验、女巫用药）
 * 2. 结算夜间死亡（调用 resolveNightActions）
 * 3. 生成预言家查验结果（调用 checkSeerResult）
 * 4. 更新玩家存活状态
 * 5. 清空夜间行动状态（为下一夜准备）
 */
export async function resolveNightPhase(state: GameGraphState): Promise<Partial<GameGraphState>> {
  const { players, wolfTarget, witchAntidoteTarget, witchPoisonTarget, guardTarget, currentDay } =
    state;

  // 找到女巫玩家（用于校验解药/毒药交叉限制）
  const witchPlayer = players.find((p) => p.role === ROLES.WITCH);
  const witchPlayerId = witchPlayer?.id;

  // 1. 结算夜间行动（狼刀、女巫用药、守卫守护）
  const nightResult = resolveNightActions({
    players,
    wolfTarget,
    guardTarget,
    witchAntidoteTarget,
    witchPoisonTarget,
    witchPlayerId,
    currentDay,
    allowWitchSelfSaveFirstNight: true, // 默认允许首夜自救
  });

  // 2. 更新玩家存活状态
  const updatedPlayers = players.map((player) => {
    const deathRecord = nightResult.deaths.find((d) => d.playerId === player.id);

    if (deathRecord) {
      // 玩家死亡
      return Object.assign(player, {
        isAlive: false,
        deathDay: currentDay,
        deathCause: deathRecord.cause,
      });
    }

    return player;
  });

  // 3. 更新女巫药剂使用状态（如果女巫使用了药）
  const playersWithWitchState = updatedPlayers.map((player) => {
    if (player.role === ROLES.WITCH) {
      const updates: Partial<typeof player> = {};

      // 解药生效：标记已使用 + 记录目标
      if (nightResult.antidoteUsed && witchAntidoteTarget) {
        updates.hasAntidoteUsed = true;
        updates.antidoteUsedOn = witchAntidoteTarget;
      }

      // 毒药生效：标记已使用 + 记录目标
      if (nightResult.poisonUsed && witchPoisonTarget) {
        updates.hasPoisonUsed = true;
        updates.poisonUsedOn = witchPoisonTarget;
      }

      return Object.assign(player, updates);
    }

    return player;
  });

  // 4. 生成预言家查验结果（如果预言家查验了）
  const seerCheckResult = state.seerCheckTarget
    ? generateSeerCheckResult(state, playersWithWitchState)
    : null;

  // 5. 清空夜间行动状态（为下一夜准备）
  return {
    players: playersWithWitchState,
    wolfTarget: null,
    witchAntidoteTarget: null,
    witchPoisonTarget: null,
    guardTarget: null,
    seerCheckTarget: null,
    currentPhase: 'day_announce',
    // 夜间结算结果（用于后续写入 Event）
    nightDeaths: nightResult.deaths,
    seerCheckResult,
  };
}

/**
 * 生成预言家查验结果
 *
 * @param state 游戏状态
 * @param players 玩家列表
 * @returns 查验结果元数据（用于写入 Event）
 */
function generateSeerCheckResult(
  state: GameGraphState,
  players: typeof state.players,
): { targetSeatNo: number; result: 'good' | 'werewolf' } | null {
  if (!state.seerCheckTarget) return null;

  const targetPlayer = players.find((p) => p.seatNo === state.seerCheckTarget);
  if (!targetPlayer) return null;

  const result = checkSeerResult(targetPlayer);

  return {
    targetSeatNo: state.seerCheckTarget,
    result,
  };
}

/**
 * 白天公布节点
 *
 * 1. 公布昨晚死亡的玩家
 * 2. 天数 +1
 */
export async function announceDayPhase(state: GameGraphState): Promise<Partial<GameGraphState>> {
  return {
    currentDay: state.currentDay + 1,
    currentPhase: 'speech', // 进入发言阶段
    // nightDeaths 保留，供日志/Event 使用
  };
}

/**
 * 胜负判定节点
 *
 * 1. 检查所有胜利条件
 * 2. 判断游戏是否结束
 * 3. 记录获胜阵营
 */
export async function checkWinConditionPhase(
  state: GameGraphState,
): Promise<Partial<GameGraphState>> {
  // 调用胜利条件判定函数
  const result = checkWinCondition(
    state.players,
    state.loverPair, // 如果有丘比特情侣
  );

  return {
    isGameOver: result.isGameOver,
    winner: result.winner,
    currentPhase: 'check_win',
  };
}
