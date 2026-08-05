import { z } from 'zod';

// 角色枚举
export const ROLES = [
  // —— 好人阵营 ——
  'villager', // 平民

  // —— 好人阵营 - 神职 ——
  'seer', // 预言家
  'witch', // 女巫
  'hunter', // 猎人
  'guard', // 守卫
  'idiot', // 白痴
  'savior', // 救世主
  'knight', // 骑士
  'magician', // 魔术师
  'elder', // 长老
  'bear', // 熊(嗅探左右邻座)
  'medium', // 通灵师(查验被放逐者身份)
  'gravekeeper', // 守墓人
  'dreamweaver', // 摄梦人
  'crow', // 乌鸦

  // —— 狼人阵营 ——
  'werewolf', // 狼人
  'wolf_king', // 狼王
  'white_wolf', // 白狼王
  'wolf_beauty', // 狼美人
  'hidden_wolf', // 隐狼
  'stone_wolf', // 石像鬼
  'demon', // 恶魔
  'nightmare', // 噩梦之影

  // —— 第三方阵营 ——
  'cupid', // 丘比特
  'fox', // 咒狐(被查验时反噬预言家)
  'thief', // 盗贼
  'ghost', // 替罪羊
  'detective', // 侦探
  'bomb', // 炸弹人
] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);
