import { z } from 'zod';

// 事件可见范围(频道)枚举
export const CHANNEL_TYPES = [
  'public', // 公共频道：e.g. 白天发言、死讯公布、投票结果
  'wolf', // 狼队频道：e.g. 夜间商议
  'system', // 系统私信 e.g. 预言家查验结果、女巫死讯等，接收人靠 actorId/targetIds 判定
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const ChannelTypeSchema = z.enum(CHANNEL_TYPES);
