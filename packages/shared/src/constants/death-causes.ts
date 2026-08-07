import { z } from 'zod';

// 死亡原因枚举
export const DEATH_CAUSES = [
  'night_kill', // 狼人夜刀
  'execution', // 白天投票放逐
  'hunter_shot', // 猎人开枪(6 人板暂无猎人,预留)
  'witch_poison', // 女巫毒杀
  // —— 扩展死因(预留,视板子) ——
  'double_save', // 同守同救
  'self_destruct', // 狼自爆
  'love_death', // 殉情
  'wolf_king_shot', // 狼王开枪致死
  'wolf_beauty_charm', // 狼美人魅惑殉情
  'white_wolf_take', // 白狼王自爆带走
  'knight_duel', // 骑士决斗失败
  'bomb_explosion', // 炸弹人被票爆炸
  'elder_curse', // 长老诅咒致神失技能间接死亡
  'referee_kill', // 系统处决(违规等)
] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];
export const DeathCauseSchema = z.enum(DEATH_CAUSES);
