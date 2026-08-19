import { z } from 'zod';

// 对局阶段枚举
export const PHASES = {
  NIGHT: 'night', // 夜晚
  DAY_ANNOUNCE: 'day_announce', // 天亮公布死讯
  SPEECH: 'speech', // 发言阶段
  VOTE: 'vote', // 投票阶段
  EXECUTE: 'execute', // 执行放逐
  CHECK_WIN: 'check_win', // 胜负判定
  SHERIFF_ELECTION: 'sheriff_election', // 警长竞选
  TIE_BREAK: 'tie_break', // 平票 PK 发言/投票
  // —— 系统事件（非玩家阶段）——
  SYSTEM: 'system', // 系统级事件（游戏开始/结束）
  JUDGE: 'judge', // 法官播报
} as const;

export type Phase = typeof PHASES[keyof typeof PHASES];

const PHASES_ARRAY = Object.values(PHASES);
export const PhaseSchema = z.enum(PHASES_ARRAY as [string, ...string[]]);
