import { z } from 'zod';

// 事件类型枚举
// 扩展：新增角色/技能只需在此追加取值
// 约束：只可追加,不可重命名/删除已用取值（历史事件行仍持有旧字符串,改名需数据回填）
// 说明：狼队夜间商议 = speech + visibility='wolf';预言家查验结果 = seer_check + visibility='seer'。
export const ACTION_TYPES = {
  // —— 生命周期 / 系统 ——
  GAME_STARTED: 'game_started', // 对局开始
  PHASE_CHANGED: 'phase_changed', // 阶段切换
  GAME_ENDED: 'game_ended', // 对局结束
  JUDGE_ANNOUNCE: 'judge_announce', // 法官播报（公开）
  NIGHT_PROMPT: 'night_prompt', // 夜间法官引导

  // —— 通用行动 ——
  SPEECH: 'speech', // 发言(狼队商议为 visibility='wolf' 的同类事件)
  VOTE: 'vote', // 投票
  PLAYER_EXECUTED: 'player_executed', // 投票放逐结算
  PLAYER_DIED: 'player_died', // 死亡结算/公布死讯(可能因守卫/女巫抵消而无此事件)
  PEACEFUL_NIGHT: 'peaceful_night', // 平安夜（无死亡公告）

  // —— 夜间角色技能 ——
  WOLF_KILL: 'wolf_kill', // 狼人刀杀
  SEER_CHECK: 'seer_check', // 预言家查验(结果设 visibility='seer')
  WITCH_SAVE: 'witch_save', // 女巫解药
  WITCH_POISON: 'witch_poison', // 女巫毒药
  GUARD_PROTECT: 'guard_protect', // 守卫守护
  BEAR_GROWL: 'bear_growl', // 熊咆哮

  // —— 白天特殊技能 ——
  HUNTER_SHOT: 'hunter_shot', // 猎人开枪
  WOLF_KING_SHOT: 'wolf_king_shot', // 狼王开枪
  IDIOT_FLIP: 'idiot_flip', // 白痴翻牌

  // —— 警长流程 ——
  SHERIFF_ELECTION: 'sheriff_election', // 警长竞选
  SHERIFF_TRANSFER: 'sheriff_transfer', // 警徽移交
  SHERIFF_DECIDE_ORDER: 'sheriff_decide_order', // 警长决定发言顺序
  SPEECH_ORDER_DETERMINED: 'speech_order_determined', // 发言顺序确定（自动计算）

  // —— 扩展角色技能 ——
  ELDER_REVIVE: 'elder_revive', // 长老第一条命
  MAGICIAN_SWAP: 'magician_swap', // 魔术师交换
  KNIGHT_DUEL: 'knight_duel', // 骑士决斗
  WHITE_WOLF_EXPLODE: 'white_wolf_explode', // 白狼王自爆带人
  WOLF_BEAUTY_CHARM: 'wolf_beauty_charm', // 狼美人魅惑
  STONE_WOLF_SCRY: 'stone_wolf_scry', // 石像鬼查验
  DEMON_KILL: 'demon_kill', // 恶魔夜刀
  CUPID_LINK: 'cupid_link', // 丘比特连情侣
  THIEF_CHOOSE: 'thief_choose', // 盗贼选身份
  SAVIOR_GUESS: 'savior_guess', // 救世主技能（值名沿用历史不可改）
  GHOST_SACRIFICE: 'ghost_sacrifice', // 替罪羊替死
  BOMB_EXPLOSION: 'bomb_explosion', // 炸弹人爆炸
  DETECTIVE_REVEAL: 'detective_reveal', // 侦探翻牌
  LOVERS_ANNOUNCE: 'lovers_announce', // 情侣公布(殉情)
} as const;

export type ActionType = typeof ACTION_TYPES[keyof typeof ACTION_TYPES];

const ACTION_TYPES_ARRAY = Object.values(ACTION_TYPES);
export const ActionTypeSchema = z.enum(ACTION_TYPES_ARRAY as [string, ...string[]]);
