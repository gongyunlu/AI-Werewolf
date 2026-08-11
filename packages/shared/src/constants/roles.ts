import { z } from 'zod';

// 角色枚举
export const ROLES = {
  // —— 好人阵营 ——
  VILLAGER: 'villager', // 平民

  // —— 好人阵营 - 神职 ——
  SEER: 'seer', // 预言家
  WITCH: 'witch', // 女巫
  HUNTER: 'hunter', // 猎人
  GUARD: 'guard', // 守卫
  IDIOT: 'idiot', // 白痴
  SAVIOR: 'savior', // 救世主
  KNIGHT: 'knight', // 骑士
  MAGICIAN: 'magician', // 魔术师
  ELDER: 'elder', // 长老
  BEAR: 'bear', // 熊(嗅探左右邻座)
  MEDIUM: 'medium', // 通灵师(查验被放逐者身份)
  GRAVEKEEPER: 'gravekeeper', // 守墓人
  DREAMWEAVER: 'dreamweaver', // 摄梦人
  CROW: 'crow', // 乌鸦

  // —— 狼人阵营 ——
  WEREWOLF: 'werewolf', // 狼人
  WOLF_KING: 'wolf_king', // 狼王
  WHITE_WOLF: 'white_wolf', // 白狼王
  WOLF_BEAUTY: 'wolf_beauty', // 狼美人
  HIDDEN_WOLF: 'hidden_wolf', // 隐狼
  STONE_WOLF: 'stone_wolf', // 石像鬼
  DEMON: 'demon', // 恶魔
  NIGHTMARE: 'nightmare', // 噩梦之影

  // —— 第三方阵营 ——
  CUPID: 'cupid', // 丘比特
  FOX: 'fox', // 咒狐(被查验时反噬预言家)
  THIEF: 'thief', // 盗贼
  GHOST: 'ghost', // 替罪羊
  DETECTIVE: 'detective', // 侦探
  BOMB: 'bomb', // 炸弹人
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// 保留用于 Zod 校验的数组
const ROLES_ARRAY = Object.values(ROLES);
export const RoleSchema = z.enum(ROLES_ARRAY as [string, ...string[]]);
