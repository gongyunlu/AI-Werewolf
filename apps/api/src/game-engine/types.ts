import { Annotation } from '@langchain/langgraph';
import type { Phase, Role, Faction } from '@ai-werewolf/shared';

/**
 * 主图节点名常量
 */
export const GAME_NODE = {
  NIGHT: 'night_phase', // 夜晚阶段
  DAY_ANNOUNCE: 'day_announce', // 天亮公布死讯
  SPEECH: 'speech_phase', // 白天发言阶段
  VOTE: 'vote_phase', // 投票阶段
  EXECUTE: 'execute_phase', // 执行放逐
  CHECK_WIN: 'check_win', // 胜负判定
} as const;

export type GameNodeName = (typeof GAME_NODE)[keyof typeof GAME_NODE];

/**
 * 单个玩家在游戏中的状态快照
 */
export interface PlayerState {
  id: string;
  seatNumber: number;
  role: Role; // 角色
  faction: Faction; // 阵营归属
  isAlive: boolean; // 是否存活
  protectedByGuard: boolean; // 本晚是否被守卫守护
  hasAntidoteUsed: boolean; // 女巫解药是否已用
  hasPoisonUsed: boolean; // 女巫毒药是否已用
  isLover?: boolean; // 是否处于情侣关系
  loverId?: string | null; // 情侣的另一方 ID（若 isLover 为 true）
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
  votingResults: Annotation<Map<string, string[]>>, // 投票结果：被投票人 ID → 投票人 ID[]
  isGameOver: Annotation<boolean>, // 是否已分出胜负
  winner: Annotation<Faction | null>, // 获胜阵营
});

export type GameGraphState = typeof GameStateAnnotation.State;
export type GameGraphUpdate = typeof GameStateAnnotation.Update;
