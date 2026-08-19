import type { GameGraphState, PlayerState } from '../core/types';
import { gameLogger } from './game-logger';

export interface SpeechOrderConfig {
  // 警长相关配置
  sheriffSpeaksLast?: boolean;
  allowSheriffChooseOrder?: boolean;
  alternateDaily?: boolean; // 每天换手

  // 无警长时的配置
  useTimeRule?: boolean;
  timeRuleConfig?: {
    oddMinuteDirection: 'clockwise' | 'counterclockwise';
    evenMinuteDirection: 'clockwise' | 'counterclockwise';
  };
  useDeathPosition?: boolean;
  deathPositionOffset?: 'next' | 'previous'; // 从死者的下一位还是上一位开始
}

export interface SpeechOrderResult {
  speechOrder: number[]; // 发言顺序（座位号数组）
  startSeatNo: number;
  direction: 'clockwise' | 'counterclockwise';
  reason: string;
  sheriffSeatNo?: number;
}

/**
 * 计算发言顺序
 *
 * 规则优先级：
 * 1. 有警长 + 警长指定 → 从警长的左边或右边开始
 * 2. 有警长 + 不允许指定/警长未指定 → 使用默认规则（从死者位置开始）
 * 3. 无警长 + 有死者 → 从死者位置开始
 * 4. 无警长 + 无死者 → 使用时间规则
 */
export function calculateSpeechOrder(params: {
  state: GameGraphState;
  config: SpeechOrderConfig;
  currentTime?: Date; // 用于时间规则
  sheriffChoice?: {
    // 警长选择的方向
    direction: 'left' | 'right'; // left=从警长左边开始（逆时针），right=从警长右边开始（顺时针）
  };
}): SpeechOrderResult {
  const { state, config, currentTime, sheriffChoice } = params;

  const alivePlayers = state.players.filter((p) => p.isAlive);
  const sheriff = alivePlayers.find((p) => p.isSheriff);

  // 情况 1: 有警长 + 警长指定了顺序
  if (sheriff && sheriffChoice && config.allowSheriffChooseOrder) {
    return calculateOrderWithSheriffChoice(alivePlayers, sheriff, sheriffChoice);
  }

  // 情况 2: 有警长 + 使用默认规则
  if (sheriff) {
    return calculateOrderWithSheriffDefault(state, alivePlayers, sheriff, config);
  }

  // 情况 3: 无警长 + 有死者
  const lastNightDeaths = state.players.filter(
    (p) => !p.isAlive && p.deathDay === state.currentDay - 1,
  );

  if (lastNightDeaths.length > 0 && config.useDeathPosition) {
    return calculateOrderFromDeathPosition(alivePlayers, lastNightDeaths, config);
  }

  // 情况 4: 无警长 + 无死者（平安夜或第一天） → 使用时间规则
  if (config.useTimeRule && currentTime) {
    return calculateOrderFromTime(alivePlayers, currentTime, config);
  }

  // 降级：从 1 号位开始顺时针
  gameLogger.warn('[发言顺序] 无匹配规则，降级为从 1 号位开始顺时针');
  return generateOrder(alivePlayers, 1, 'clockwise', 'fallback_default', undefined);
}

/**
 * 情况 1: 警长指定方向
 */
function calculateOrderWithSheriffChoice(
  alivePlayers: PlayerState[],
  sheriff: PlayerState,
  choice: { direction: 'left' | 'right' },
): SpeechOrderResult {
  const { direction } = choice;

  // 将 left/right 转换为 clockwise/counterclockwise
  // left = 逆时针（座位号递减）
  // right = 顺时针（座位号递增）
  const actualDirection = direction === 'left' ? 'counterclockwise' : 'clockwise';

  // 起始位置：警长的下一位（按方向）
  const startSeatNo = getNextSeatNo(sheriff.seatNo!, alivePlayers, actualDirection);

  return generateOrder(
    alivePlayers,
    startSeatNo,
    actualDirection,
    `sheriff_choice_${direction}`,
    sheriff.seatNo,
  );
}

/**
 * 情况 2: 有警长，使用默认规则
 */
function calculateOrderWithSheriffDefault(
  state: GameGraphState,
  alivePlayers: PlayerState[],
  sheriff: PlayerState,
  config: SpeechOrderConfig,
): SpeechOrderResult {
  // 检查是否有昨晚的死者
  const lastNightDeaths = state.players.filter(
    (p) => !p.isAlive && p.deathDay === state.currentDay - 1,
  );

  let startSeatNo: number;
  let reason: string;

  if (lastNightDeaths.length > 0) {
    // 从最小座位号的死者的下一位开始
    const minDeathSeat = Math.min(...lastNightDeaths.map((p) => p.seatNo!));
    startSeatNo = getNextSeatNo(minDeathSeat, alivePlayers, 'clockwise');
    reason = 'sheriff_default_from_death';
  } else {
    // 平安夜或第一天，从警长的下一位开始
    startSeatNo = getNextSeatNo(sheriff.seatNo!, alivePlayers, 'clockwise');
    reason = 'sheriff_default_peaceful_night';
  }

  // 检查是否需要每天换手
  const direction =
    config.alternateDaily && state.currentDay % 2 === 0 ? 'counterclockwise' : 'clockwise';

  return generateOrder(alivePlayers, startSeatNo, direction, reason, sheriff.seatNo);
}

/**
 * 情况 3: 无警长，从死者位置开始
 */
function calculateOrderFromDeathPosition(
  alivePlayers: PlayerState[],
  deaths: PlayerState[],
  config: SpeechOrderConfig,
): SpeechOrderResult {
  // 从最小座位号的死者开始
  const minDeathSeat = Math.min(...deaths.map((p) => p.seatNo!));

  const offset = config.deathPositionOffset || 'next';
  const direction = 'clockwise'; // 默认顺时针

  const startSeatNo =
    offset === 'next'
      ? getNextSeatNo(minDeathSeat, alivePlayers, direction)
      : getPreviousSeatNo(minDeathSeat, alivePlayers);

  return generateOrder(alivePlayers, startSeatNo, direction, 'from_death_position', undefined);
}

/**
 * 情况 4: 无警长 + 无死者，使用时间规则
 */
function calculateOrderFromTime(
  alivePlayers: PlayerState[],
  currentTime: Date,
  config: SpeechOrderConfig,
): SpeechOrderResult {
  const minutes = currentTime.getMinutes();
  const tens = Math.floor(minutes / 10);
  const ones = minutes % 10;
  const sum = tens + ones;

  // 计算起始座位号（对玩家总数取模）
  const maxSeatNo = Math.max(...alivePlayers.map((p) => p.seatNo!));
  const startSeatNo = (sum % maxSeatNo) + 1;

  // 根据分钟数奇偶性决定方向
  const isOdd = minutes % 2 === 1;
  const direction = isOdd
    ? config.timeRuleConfig?.oddMinuteDirection || 'clockwise'
    : config.timeRuleConfig?.evenMinuteDirection || 'counterclockwise';

  const reason = `time_rule_${minutes}_${direction}`;

  return generateOrder(alivePlayers, startSeatNo, direction, reason, undefined);
}

/**
 * 生成最终的发言顺序数组
 */
function generateOrder(
  alivePlayers: PlayerState[],
  startSeatNo: number,
  direction: 'clockwise' | 'counterclockwise',
  reason: string,
  sheriffSeatNo?: number,
): SpeechOrderResult {
  const sorted = [...alivePlayers].toSorted((a, b) => a.seatNo! - b.seatNo!);

  let order: number[];

  if (direction === 'clockwise') {
    // 顺时针：从 startSeatNo 开始，座位号递增
    const startIndex = sorted.findIndex((p) => p.seatNo === startSeatNo);
    order = [
      ...sorted.slice(startIndex).map((p) => p.seatNo!),
      ...sorted.slice(0, startIndex).map((p) => p.seatNo!),
    ];
  } else {
    // 逆时针：从 startSeatNo 开始，座位号递减
    const reversed = [...sorted].toReversed();
    const startIndex = reversed.findIndex((p) => p.seatNo === startSeatNo);
    order = [
      ...reversed.slice(startIndex).map((p) => p.seatNo!),
      ...reversed.slice(0, startIndex).map((p) => p.seatNo!),
    ];
  }

  // 警长最后发言
  if (sheriffSeatNo) {
    const sheriffIndex = order.indexOf(sheriffSeatNo);
    if (sheriffIndex !== -1) {
      order.splice(sheriffIndex, 1);
      order.push(sheriffSeatNo);
    }
  }

  return {
    speechOrder: order,
    startSeatNo,
    direction,
    reason,
    sheriffSeatNo,
  };
}

/**
 * 获取下一个存活玩家的座位号（顺时针）
 */
function getNextSeatNo(
  currentSeatNo: number,
  alivePlayers: PlayerState[],
  direction: 'clockwise' | 'counterclockwise',
): number {
  const sorted = [...alivePlayers].toSorted((a, b) => a.seatNo! - b.seatNo!);

  if (direction === 'clockwise') {
    const next = sorted.find((p) => p.seatNo! > currentSeatNo);
    return next ? next.seatNo! : sorted[0].seatNo!;
  } else {
    const reversed = [...sorted].toReversed();
    const next = reversed.find((p) => p.seatNo! < currentSeatNo);
    return next ? next.seatNo! : reversed[0].seatNo!;
  }
}

/**
 * 获取上一个存活玩家的座位号（逆时针）
 */
function getPreviousSeatNo(currentSeatNo: number, alivePlayers: PlayerState[]): number {
  const sorted = [...alivePlayers].toSorted((a, b) => a.seatNo! - b.seatNo!);
  const reversed = [...sorted].toReversed();
  const prev = reversed.find((p) => p.seatNo! < currentSeatNo);
  return prev ? prev.seatNo! : reversed[0].seatNo!;
}
