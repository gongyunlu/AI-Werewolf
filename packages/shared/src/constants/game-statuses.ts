import { z } from 'zod';

// 对局状态枚举
export const GAME_STATUSES = [
  'pending', // 待开始
  'running', // 进行中
  'finished', // 正常结束
  'aborted', // 异常终止
] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];
export const GameStatusSchema = z.enum(GAME_STATUSES);
