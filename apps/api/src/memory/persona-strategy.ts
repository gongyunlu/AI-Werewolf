/**
 * 人设与策略两类记忆的公共口径。
 *
 * 这两类按 type 过滤读取（importance 降序），不参与向量检索，
 * 因此读、写、注入三处必须用同一套重要性分层，否则人设会被经验记忆挤出窗口。
 */

/** 人设与策略的 type 取值 */
export const PERSONA_STRATEGY_TYPES = ['persona', 'strategy'] as const;

/** 人设层：表达风格、思维习惯、情绪特征等长期稳定的特质，注入时排在策略之前 */
export const PERSONA_IMPORTANCE = 1.0;

/** 策略层：战术倾向而非结论，具体动作仍由角色与场况推理产出 */
export const STRATEGY_IMPORTANCE = 0.6;

/** 单次注入的条数上限，与 MemoryService.retrieveActiveMemories 的默认 limit 一致 */
export const PERSONA_STRATEGY_INJECTION_LIMIT = 20;

export type PersonaStrategyKind = (typeof PERSONA_STRATEGY_TYPES)[number];

export type PersonaStrategyItem = { title: string; content: string };
