import { z } from 'zod';

// 事件类型枚举
// 扩展：新增角色/技能只需在此追加取值
// 约束：只可追加,不可重命名/删除已用取值（历史事件行仍持有旧字符串,改名需数据回填）
// 说明：狼队夜间商议 = speech + channel='wolf';预言家查验结果 = seer_check + channel='system'。
export const ACTION_TYPES = [
  // —— 生命周期 / 系统 ——
  'game_started', // 对局开始
  'phase_changed', // 阶段切换
  'game_ended', // 对局结束

  // —— 通用行动 ——
  'speech', // 发言(狼队商议为 channel='wolf' 的同类事件)
  'vote', // 投票
  'player_executed', // 投票放逐结算
  'player_died', // 死亡结算/公布死讯(可能因守卫/女巫抵消而无此事件)

  // —— 夜间角色技能 ——
  'wolf_kill', // 狼人刀杀
  'seer_check', // 预言家查验(结果发 system 频道)
  'witch_save', // 女巫解药
  'witch_poison', // 女巫毒药
  'guard_protect', // 守卫守护(预留,视板子)
  'bear_growl', // 熊咆哮(预留,视板子)

  // —— 白天特殊技能 ——
  'hunter_shot', // 猎人开枪(预留,MVP 6 人板无猎人)
  'wolf_king_shot', // 狼王开枪(预留)
  'idiot_flip', // 白痴翻牌(预留)

  // —— 警长流程 ——
  'sheriff_election', // 警长竞选
  'sheriff_transfer', // 警徽移交

  // —— 扩展角色技能(预留,视板子) ——
  'elder_revive', // 长老第一条命
  'magician_swap', // 魔术师交换
  'knight_duel', // 骑士决斗
  'white_wolf_explode', // 白狼王自爆带人
  'wolf_beauty_charm', // 狼美人魅惑
  'stone_wolf_scry', // 石像鬼查验
  'demon_kill', // 恶魔夜刀
  'cupid_link', // 丘比特连情侣
  'thief_choose', // 盗贼选身份
  'savior_guess', // 救世主技能(注:值名沿用历史不可改;咒狐 fox 为独立角色,技能事件待其机制定稿后另加)
  'ghost_sacrifice', // 替罪羊替死
  'bomb_explosion', // 炸弹人爆炸
  'detective_reveal', // 侦探翻牌
  'lovers_announce', // 情侣公布(殉情)
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ActionTypeSchema = z.enum(ACTION_TYPES);
