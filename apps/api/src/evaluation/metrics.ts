import { ACTION_TYPES, FACTIONS } from '@ai-werewolf/shared';

/**
 * 玩家表现指标计算
 *
 * 输入 Player/Event 子集，输出 AgentPerformance 各字段值
 * 不依赖 Prisma 类型以便单测
 */

/** 结算用的玩家轻量视图（取自 Player 表） */
export interface MetricPlayer {
  id: string;
  seatNo: number | null;
  role: string | null;
  faction: string | null;
  deathDay: number | null;
  deathCause: string | null;
}

/** 结算用的事件轻量视图（取自 Event 表） */
export interface MetricEvent {
  id: string;
  sequence: number;
  day: number | null;
  actionType: string;
  actorId: string | null;
  content: Record<string, unknown>;
}

/** 单个玩家的完整结算指标 */
export interface PlayerMetrics {
  survivalDays: number;
  deathCause: string | null;
  isWinner: boolean;
  voteAccuracy: number | null;
  abilityUseCount: number;
  speechCount: number;
  speechAvgTokens: number | null;
  score: number;
}

/** 对局关键事件摘要 */
export interface KeyEvent {
  day: number;
  type: 'first_blood' | 'execution' | 'game_end';
  seatNo?: number;
  winner?: string;
}

/** MVP 候选（供并列时按次序打破平局） */
export interface MvpCandidate {
  playerId: string;
  score: number;
  isWinner: boolean;
  survivalDays: number;
  voteAccuracy: number | null;
}

function readNumber(content: Record<string, unknown>, key: string): number | undefined {
  const value = content[key];
  return typeof value === 'number' ? value : undefined;
}

function readString(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 粗略估算 token 数（中文 2 字符 ≈ 1 token）
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/**
 * 存活天数：死亡者取死亡当天，存活到终局者记满 totalDays
 */
export function computeSurvivalDays(player: MetricPlayer, totalDays: number): number {
  return player.deathDay ?? totalDays;
}

/**
 * 投票正确率（用真实身份评判）
 *
 * - 好人投狼 → 对；狼人投非狼（好人/第三方）→ 对；第三方 → 中性不计。
 * - 弃权/无效票（targetSeatNo===0）与无法解析目标 → 中性跳过。
 * - 平票/PK 无需特殊处理：每次投票独立评判目标身份。
 */
export function computeVoteAccuracy(
  player: MetricPlayer,
  players: MetricPlayer[],
  events: MetricEvent[],
): number | null {
  const voterFaction = player.faction;
  if (!voterFaction || voterFaction === FACTIONS.THIRD_PARTY) {
    return null; // 第三方/未知阵营不评判
  }

  const seatToFaction = new Map<number, string | null>();
  for (const p of players) {
    if (p.seatNo !== null) {
      seatToFaction.set(p.seatNo, p.faction);
    }
  }

  let correct = 0;
  let counted = 0;

  for (const e of events) {
    if (e.actionType !== ACTION_TYPES.VOTE || e.actorId !== player.id) {
      continue;
    }

    const targetSeatNo = readNumber(e.content, 'targetSeatNo');
    if (targetSeatNo === undefined || targetSeatNo === 0) {
      continue; // 弃权/无效 → 中性
    }

    const targetFaction = seatToFaction.get(targetSeatNo);
    if (targetFaction === undefined || targetFaction === null) {
      continue; // 目标无法解析 → 中性
    }

    const isCorrect =
      voterFaction === FACTIONS.WEREWOLF
        ? targetFaction !== FACTIONS.WEREWOLF // 狼人投好人/第三方算对
        : targetFaction === FACTIONS.WEREWOLF; // 好人投狼算对

    if (isCorrect) {
      correct += 1;
    }
    counted += 1;
  }

  return counted === 0 ? null : correct / counted;
}

/**
 * 技能使用次数
 *
 * wolf_kill 为团队决策不计入个人
 */
export function countAbilityUses(player: MetricPlayer, events: MetricEvent[]): number {
  let count = 0;

  for (const e of events) {
    if (e.actorId !== player.id) {
      continue;
    }

    if (e.actionType === ACTION_TYPES.SEER_CHECK) {
      count += 1;
    } else if (e.actionType === ACTION_TYPES.WITCH_SAVE && e.content.saved === true) {
      count += 1; // 未用药（targetSeatNo=0 → saved=false）不计
    } else if (e.actionType === ACTION_TYPES.WITCH_POISON && e.content.used === true) {
      count += 1;
    }
  }

  return count;
}

/** 发言次数（含白天公开与狼人夜间讨论） */
export function countSpeech(player: MetricPlayer, events: MetricEvent[]): number {
  return events.filter((e) => e.actionType === ACTION_TYPES.SPEECH && e.actorId === player.id)
    .length;
}

/** 平均发言 token 数（无发言时返回 null） */
export function averageSpeechTokens(player: MetricPlayer, events: MetricEvent[]): number | null {
  const speeches = events.filter(
    (e) => e.actionType === ACTION_TYPES.SPEECH && e.actorId === player.id,
  );
  if (speeches.length === 0) {
    return null;
  }

  const total = speeches.reduce((sum, e) => {
    const speech = readString(e.content, 'speech');
    return sum + (speech ? estimateTokens(speech) : 0);
  }, 0);

  return Math.round(total / speeches.length);
}

/**
 * 综合分（0~100）
 *
 * 权重：胜率主导（最终目标）60% + 存活占比 25% + 投票精度 15%，确定且可横向比较。
 */
export function computeScore(input: {
  isWinner: boolean;
  survivalDays: number;
  totalDays: number;
  voteAccuracy: number | null;
}): number {
  const { isWinner, survivalDays, totalDays, voteAccuracy } = input;
  const effectiveVoteAcc = voteAccuracy ?? 0.5;
  const survivalRatio = totalDays > 0 ? survivalDays / totalDays : 0;
  const raw = 100 * (0.6 * (isWinner ? 1 : 0) + 0.25 * survivalRatio + 0.15 * effectiveVoteAcc);
  return Math.round(raw * 100) / 100;
}

/** 从死亡公告事件 content 中提取首血座位号 */
function firstDeathSeatNo(content: Record<string, unknown>): number | undefined {
  const deaths = content.deaths;
  if (!Array.isArray(deaths) || deaths.length === 0) {
    return undefined;
  }
  const first = deaths[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  return readNumber(first as Record<string, unknown>, 'seatNo');
}

/**
 * 抽取对局关键事件（首血 / 放逐 / 终局），按 sequence 升序，最多 10 条
 */
export function selectKeyEvents(events: MetricEvent[]): KeyEvent[] {
  const result: KeyEvent[] = [];
  let firstBloodRecorded = false;

  for (const e of events) {
    const day = e.day ?? 0;

    if (e.actionType === ACTION_TYPES.PLAYER_DIED && !firstBloodRecorded) {
      const seatNo = firstDeathSeatNo(e.content);
      result.push({ day, type: 'first_blood', ...(seatNo !== undefined ? { seatNo } : {}) });
      firstBloodRecorded = true;
    } else if (e.actionType === ACTION_TYPES.PLAYER_EXECUTED) {
      const seatNo = readNumber(e.content, 'targetSeatNo');
      result.push({ day, type: 'execution', ...(seatNo !== undefined ? { seatNo } : {}) });
    } else if (e.actionType === ACTION_TYPES.GAME_ENDED) {
      const winner = readString(e.content, 'winner');
      result.push({ day, type: 'game_end', ...(winner !== undefined ? { winner } : {}) });
    }

    if (result.length >= 10) {
      break;
    }
  }

  return result;
}

/**
 * 选出 MVP：score 最高者，并列按 isWinner → survivalDays → voteAccuracy 依次打破平局
 */
export function selectMvp(candidates: MvpCandidate[]): string | null {
  if (candidates.length === 0) {
    return null;
  }

  const sorted = candidates.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.isWinner !== a.isWinner) return b.isWinner ? 1 : -1;
    if (b.survivalDays !== a.survivalDays) return b.survivalDays - a.survivalDays;
    return (b.voteAccuracy ?? -1) - (a.voteAccuracy ?? -1);
  });

  return sorted[0].playerId;
}

/** 计算单个玩家的完整指标 */
export function computePlayerMetrics(
  player: MetricPlayer,
  players: MetricPlayer[],
  events: MetricEvent[],
  totalDays: number,
  winnerFaction: string,
): PlayerMetrics {
  const survivalDays = computeSurvivalDays(player, totalDays);
  const voteAccuracy = computeVoteAccuracy(player, players, events);
  const isWinner = player.faction !== null && player.faction === winnerFaction;

  return {
    survivalDays,
    deathCause: player.deathCause,
    isWinner,
    voteAccuracy,
    abilityUseCount: countAbilityUses(player, events),
    speechCount: countSpeech(player, events),
    speechAvgTokens: averageSpeechTokens(player, events),
    score: computeScore({ isWinner, survivalDays, totalDays, voteAccuracy }),
  };
}
