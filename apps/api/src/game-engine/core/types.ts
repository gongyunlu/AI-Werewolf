import { Annotation } from '@langchain/langgraph';
import type { Phase, Role, Faction } from '@ai-werewolf/shared';

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
  deathCause: string | null; // 死亡原因
  protectedByGuard: boolean; // 本晚是否被守卫守护
  hasAntidoteUsed: boolean; // 女巫解药是否已用
  hasPoisonUsed: boolean; // 女巫毒药是否已用
  antidoteUsedOn: string | null; // 女巫解药使用的目标玩家 ID
  poisonUsedOn: string | null; // 女巫毒药使用的目标玩家 ID
  isLover?: boolean; // 是否处于情侣关系
  loverId?: string | null; // 情侣的另一方 ID（若 isLover 为 true）
  isSheriff?: boolean; // 是否是警长
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
 * 每个 channel 独立更新（默认 last-write-wins），节点返回部分字段即可
 */
export const GameStateAnnotation = Annotation.Root({
  gameId: Annotation<string>,
  currentDay: Annotation<number>, // 当前天数
  currentPhase: Annotation<Phase>, // 当前阶段
  players: Annotation<PlayerState[]>, // 所有玩家状态快照
  eventSequence: Annotation<number>, // 事件序列号（用于排序）
  wolfTarget: Annotation<string | null>, // 狼人本晚刀的目标玩家 ID
  witchAntidoteTarget: Annotation<string | null>, // 女巫解药目标
  witchPoisonTarget: Annotation<string | null>, // 女巫毒药目标
  guardTarget: Annotation<string | null>, // 守卫守护目标
  seerCheckTarget: Annotation<number | null>, // 预言家查验目标（座位号）
  exileTarget: Annotation<string | null>, // 白天投票放逐的目标玩家 ID
  exileVoteCount: Annotation<number | null>, // 被放逐玩家获得的票数
  votingResults: Annotation<Map<string, string[]>>, // 投票结果：被投票人 ID → 投票人 ID[]
  isGameOver: Annotation<boolean>, // 是否已分出胜负
  winner: Annotation<Faction | null>, // 获胜阵营
  loverPair: Annotation<string[] | null>, // 丘比特情侣对 [playerId1, playerId2]
  // 夜间结算结果
  nightDeaths: Annotation<Array<{ playerId: string; cause: string }> | null>,
  seerCheckResult: Annotation<{ targetSeatNo: number; result: 'good' | 'werewolf' } | null>,
  interrupt: Annotation<GameInterrupt | null>, // 中断标记
  nextIsDay: Annotation<boolean>, // 内部标记：下一阶段是否为白天（用于条件边路由）
  // 发言顺序相关
  speechOrder: Annotation<number[] | null>, // 当前发言顺序（座位号数组）
  speechDirection: Annotation<'clockwise' | 'counterclockwise' | null>, // 当前发言方向
  speechStartSeatNo: Annotation<number | null>, // 起始座位号
  speechOrderReason: Annotation<string | null>, // 顺序计算原因（用于审计）
  rulesetId: Annotation<string>, // Ruleset ID（用于读取配置）
  // 平票PK相关
  pkCandidates: Annotation<number[] | null>, // 平票PK的候选人座位号
  pkRound: Annotation<number>, // PK轮次（0=未PK，1=第一次PK，2=第二次PK...）
  lastVoteResults: Annotation<Map<number, number> | null>, // 上一轮投票结果（座位号 -> 得票数）
});

export type GameGraphState = typeof GameStateAnnotation.State;
export type GameGraphUpdate = typeof GameStateAnnotation.Update;
