/**
 * Agent 场景常量
 *
 * 定义所有可用的 Agent 场景类型
 */
export const AGENT_SCENARIOS = {
  /** 投票阶段 */
  VOTE: 'vote',
  /** 白天发言阶段 */
  DAY_SPEECH: 'day_speech',
  /** 夜间行动阶段 */
  NIGHT_ACTION: 'night_action',
  /** 遗言阶段 */
  LAST_WORDS: 'last_words',
  /** 警长决定发言顺序 */
  SHERIFF_DECIDE_ORDER: 'sheriff_decide_order',
} as const;

/**
 * Agent 场景类型
 */
export type AgentScenario =
  (typeof AGENT_SCENARIOS)[keyof typeof AGENT_SCENARIOS];
