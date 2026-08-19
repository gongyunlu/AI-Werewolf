import { z } from 'zod';

// 死亡原因枚举
export const DEATH_CAUSES = {
  NIGHT_KILL: 'night_kill', // 狼人夜刀
  EXECUTION: 'execution', // 白天投票放逐
  HUNTER_SHOT: 'hunter_shot', // 猎人开枪
  WITCH_POISON: 'witch_poison', // 女巫毒杀
  // —— 扩展死因 ——
  DOUBLE_SAVE: 'double_save', // 同守同救
  SELF_DESTRUCT: 'self_destruct', // 狼自爆
  LOVE_DEATH: 'love_death', // 殉情
  WOLF_KING_SHOT: 'wolf_king_shot', // 狼王开枪致死
  WOLF_BEAUTY_CHARM: 'wolf_beauty_charm', // 狼美人魅惑殉情
  WHITE_WOLF_TAKE: 'white_wolf_take', // 白狼王自爆带走
  KNIGHT_DUEL: 'knight_duel', // 骑士决斗失败
  BOMB_EXPLOSION: 'bomb_explosion', // 炸弹人被票爆炸
  ELDER_CURSE: 'elder_curse', // 长老诅咒致神失技能间接死亡
  REFEREE_KILL: 'referee_kill', // 系统处决(违规等)
} as const;

export type DeathCause = typeof DEATH_CAUSES[keyof typeof DEATH_CAUSES];

const DEATH_CAUSES_ARRAY = Object.values(DEATH_CAUSES);
export const DeathCauseSchema = z.enum(DEATH_CAUSES_ARRAY as [string, ...string[]]);
