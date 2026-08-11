import { z } from 'zod';

// 对局状态枚举
export const GAME_STATUSES = {
  CREATED: 'created', // 已创建
  INITIALIZED: 'initialized', // 已初始化
  PENDING: 'pending', // 待开始
  RUNNING: 'running', // 进行中
  FINISHED: 'finished', // 正常结束
  ABORTED: 'aborted', // 异常终止
} as const;

export type GameStatus = typeof GAME_STATUSES[keyof typeof GAME_STATUSES];

const GAME_STATUSES_ARRAY = Object.values(GAME_STATUSES);
export const GameStatusSchema = z.enum(GAME_STATUSES_ARRAY as [string, ...string[]]);
