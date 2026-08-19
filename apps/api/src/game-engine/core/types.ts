import type { Phase, Role, Faction, SeerCheckResult } from '@ai-werewolf/shared';

/**
 * 主图节点名常量
 */
export const GAME_NODE = {
  INIT: 'init', // 初始化
  NIGHT: 'night_phase', // 夜晚阶段
  DAY: 'day', // 白天阶段
  CHECK_WIN: 'check_win', // 胜负判定
  GAME_END: 'game_end', // 游戏结束
  // 子节点
  DAY_ANNOUNCE: 'day_announce', // 天亮公布死讯
  SPEECH: 'speech_phase', // 白天发言阶段
  VOTE: 'vote_phase', // 投票阶段
  EXECUTE: 'execute_phase', // 执行放逐
} as const;

export type GameNodeName = (typeof GAME_NODE)[keyof typeof GAME_NODE];

/**
 * 单个玩家在游戏中的状态快照
 */
export interface PlayerState {
  id: string;
  seatNo: number;
  role: Role;
  faction: Faction; // 阵营归属
  isAlive: boolean;
  deathDay: number | null; // null 表示存活
  deathCause: string | null;
  protectedByGuard: boolean; // 本晚是否被守卫守护
  hasAntidoteUsed: boolean;
  hasPoisonUsed: boolean;
  antidoteUsedOn: string | null; // 女巫解药使用的目标玩家 ID
  poisonUsedOn: string | null; // 女巫毒药使用的目标玩家 ID
  isLover?: boolean;
  loverId?: string | null; // 情侣的另一方 ID（若 isLover 为 true）
  isSheriff?: boolean;
}

/**
 * 中断事件类型
 * 狼人自爆、骑士决斗等
 */
export interface GameInterrupt {
  type: 'wolf_explode' | 'knight_duel' | 'white_wolf_explode';
  triggeredBy: string; // 触发者玩家 ID
  metadata?: any; // 额外元数据（如决斗目标）
}

/**
 * 游戏主图全局状态
 */
export interface GameGraphState {
  gameId: string;
  currentDay: number;
  currentPhase: Phase;
  players: PlayerState[];
  eventSequence: number;
  wolfTarget: string | null; // 狼人本晚刀的目标玩家 ID
  witchAntidoteTarget: string | null;
  witchPoisonTarget: string | null;
  guardTarget: string | null;
  seerCheckTarget: number | null; // 预言家查验目标（座位号）
  exileTarget: string | null; // 白天投票放逐的目标玩家 ID
  exileVoteCount: number | null; // 被放逐玩家获得的票数
  votingResults: Map<string, string[]>; // 投票结果：被投票人 ID → 投票人 ID[]
  isGameOver: boolean;
  winner: Faction | null;
  loverPair: string[] | null; // 丘比特情侣对 [playerId1, playerId2]
  // 夜间结算结果
  nightDeaths: Array<{ playerId: string; cause: string }> | null;
  seerCheckResult: { targetSeatNo: number; result: SeerCheckResult } | null;
  interrupt: GameInterrupt | null;
  nextIsDay: boolean; // 内部标记：下一阶段是否为白天（用于条件边路由）
  // 发言顺序相关
  speechOrder: number[] | null; // 当前发言顺序（座位号数组）
  speechDirection: 'clockwise' | 'counterclockwise' | null;
  speechStartSeatNo: number | null;
  speechOrderReason: string | null; // 顺序计算原因（用于审计）
  rulesetId: string;
  // 平票PK相关
  pkCandidates: number[] | null; // 平票PK的候选人座位号
  pkRound: number; // PK轮次（0=未PK，1=第一次PK，2=第二次PK...）
  lastVoteResults: Map<number, number> | null; // 上一轮投票结果（座位号 -> 得票数）
}

export type GameGraphUpdate = Partial<GameGraphState>;
