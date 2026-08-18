// 从 shared 包导入通用类型
import type { GameStatus, Phase, Faction } from '@ai-werewolf/shared';

// 玩家状态（基于 deathDay 判断）
export type PlayerStatus = 'alive' | 'dead';

// 阵营别名（兼容前端命名）
export type Camp = Faction | 'unknown';

// 游戏阶段别名（兼容前端命名）
export type GamePhase = Phase;

// 角色类型（从 shared 导入）
export type Role = string;

// 玩家信息
export interface Player {
  seatNumber: number;
  name: string;
  role?: Role;
  camp?: Camp;
  status: PlayerStatus;
  votedFor?: number | null;
  isProtected?: boolean;
  isPoisoned?: boolean;
  isSilenced?: boolean;
  modelName?: string;
  isSheriff?: boolean;
}

// 发言记录
export interface Speech {
  id: string;
  round: number;
  phase: GamePhase;
  seatNumber: number;
  content: string;
  thinking?: string;
  /** 合并后的完整文本（thinking + content） */
  fullText: string;
  timestamp: string;
  isStreaming?: boolean;
}

// 游戏信息
export interface Game {
  id: string;
  status: GameStatus;
  phase: GamePhase;
  currentRound: number;
  currentSpeaker: number | null;
  players: Player[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  winnerFaction?: 'villager' | 'werewolf' | 'third_party' | null;
  totalDays?: number;
}

// 对局列表项
export interface GameListItem {
  id: string;
  status: string;
  rulesetId: string;
  startedAt: string;
  endedAt: string | null;
  winnerFaction: string | null;
  totalDays: number | null;
  ruleset: {
    id: string;
    name: string;
  };
  players: Array<{
    id: string;
    seatNo: number | null;
    role: string | null;
    faction: string | null;
    deathDay: number | null;
    displayName: string;
    modelName: string;
    isSheriff: boolean;
  }>;
}

// 对局列表响应
export interface GamesListResponse {
  items: GameListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// 观战视角类型
export type ViewPerspective = 'god' | 'werewolf' | 'villager' | number;

// 视角模式（不包括具体玩家座位号）
export type ViewMode = 'god' | 'werewolf' | 'villager';

// 视角过滤后的玩家信息
export interface FilteredPlayer extends Omit<Player, 'role' | 'camp'> {
  role?: Role;
  camp?: Camp;
  isVisible: boolean;
}

// 视角过滤后的发言
export interface FilteredSpeech extends Speech {
  isVisible: boolean;
}
