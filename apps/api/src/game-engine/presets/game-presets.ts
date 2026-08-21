/**
 * 板子配置接口
 *
 * 定义游戏规则、角色配置和节点管道
 */
export interface GamePreset {
  /** 板子名称 */
  name: string;

  /** 角色列表（按座位号顺序，可选） */
  roles?: string[];

  /** 夜间节点管道（按执行顺序） */
  nightPipeline: string[];

  /** 白天节点管道（按执行顺序） */
  dayPipeline: string[];

  /** 可选的特殊规则配置 */
  rules?: {
    /** 是否启用屠边判定 */
    enableSlaughterRule?: boolean;

    /** 是否启用人狼恋 */
    enableLovers?: boolean;

    /** 其他规则... */
    [key: string]: any;
  };
}

/**
 * 标准 6 人局配置
 *
 * 角色：2 狼人 + 1 预言家 + 1 女巫 + 2 平民
 */
export const Standard6pPreset: GamePreset = {
  name: '标准 6 人局',
  roles: ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'],

  nightPipeline: [
    'werewolfKill', // 狼人刀人
    'witchAntidote', // 女巫解药
    'witchPoison', // 女巫毒药
    'seerCheck', // 预言家查验
    'nightResolve', // 夜间结算
  ],

  dayPipeline: [
    'announceDay', // 公布死讯
    'wolfExplode', // 狼人自爆（天亮公布死讯后，任一狼自爆即跳过发言投票进入黑夜）
    'processDeathSkills', // 处理死亡技能
    'lastWords', // 死者遗言
    'sheriffDecideOrder', // 警长决定发言顺序
    'calculateSpeechOrder', // 计算发言顺序（无警长或警长未指定时）
    'speech', // 发言讨论
    'vote', // 投票放逐
    'pkSpeech', // 平票PK发言
    'pkVote', // 平票PK投票
    'execute', // 执行放逐
    'checkWin', // 放逐后立即判定胜负（避免先发遗言再判胜负）
    'exileLastWords', // 被放逐者遗言
    'processExileSkills', // 处理放逐触发技能
  ],

  rules: {
    enableSlaughterRule: true, // 启用屠边判定
    enableLovers: false, // 不启用人狼恋
  },
};

/**
 * 标准 9 人局配置
 *
 * 角色：3 狼人 + 1 预言家 + 1 女巫 + 1 猎人 + 3 平民
 */
export const Standard9pPreset: GamePreset = {
  name: '标准 9 人局',
  roles: [
    'werewolf',
    'werewolf',
    'werewolf',
    'seer',
    'witch',
    'hunter',
    'villager',
    'villager',
    'villager',
  ],

  nightPipeline: ['werewolfKill', 'witchAntidote', 'witchPoison', 'seerCheck', 'nightResolve'],

  dayPipeline: [
    'announceDay',
    'wolfExplode', // 狼人自爆（天亮公布死讯后）
    'processDeathSkills',
    'lastWords', // 死者遗言
    'sheriffDecideOrder', // 警长决定发言顺序
    'calculateSpeechOrder', // 计算发言顺序（无警长或警长未指定时）
    'speech',
    'vote',
    'pkSpeech', // 平票PK发言
    'pkVote', // 平票PK投票
    'execute',
    'checkWin', // 放逐后立即判定胜负（避免先发遗言再判胜负）
    'exileLastWords', // 被放逐者遗言
    'processExileSkills', // 处理放逐触发技能
    // TODO: 猎人开枪（hunterShoot）尚未实现
  ],

  rules: {
    enableSlaughterRule: true,
    enableLovers: false,
  },
};

/**
 * 守卫局配置
 *
 * 角色：2 狼人 + 1 预言家 + 1 女巫 + 1 守卫 + 1 平民
 */
export const GuardPreset: GamePreset = {
  name: '守卫局',
  roles: ['werewolf', 'werewolf', 'seer', 'witch', 'guard', 'villager'],

  nightPipeline: [
    'werewolfKill',
    // TODO: 守卫守护（guardProtect）尚未实现
    'witchAntidote', // 女巫解药
    'witchPoison', // 女巫毒药
    'seerCheck',
    'nightResolve',
  ],

  dayPipeline: [
    'announceDay',
    'wolfExplode', // 狼人自爆（天亮公布死讯后）
    'processDeathSkills',
    'lastWords',
    'sheriffDecideOrder', // 警长决定发言顺序
    'calculateSpeechOrder', // 计算发言顺序（无警长或警长未指定时）
    'speech',
    'vote',
    'pkSpeech', // 平票PK发言
    'pkVote', // 平票PK投票
    'execute',
    'checkWin', // 放逐后立即判定胜负（避免先发遗言再判胜负）
    'exileLastWords',
    'processExileSkills',
  ],

  rules: {
    enableSlaughterRule: true,
    enableLovers: false,
  },
};

/**
 * 默认板子配置
 */
export const DEFAULT_PRESET = Standard6pPreset;

/**
 * 所有预设板子
 */
export const ALL_PRESETS: Record<string, GamePreset> = {
  standard6p: Standard6pPreset,
  standard9p: Standard9pPreset,
  guard: GuardPreset,
};
