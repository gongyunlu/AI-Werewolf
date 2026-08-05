import { z } from 'zod';

// 对局阶段枚举
export const PHASES = [
  'night', // 夜晚
  'day_announce', // 天亮公布死讯
  'speech', // 发言阶段
  'vote', // 投票阶段
  'execute', // 执行放逐
  'check_win', // 胜负判定
  'sheriff_election', // 警长竞选
  'tie_break', // 平票 PK 发言/投票
] as const;
export type Phase = (typeof PHASES)[number];
export const PhaseSchema = z.enum(PHASES);
