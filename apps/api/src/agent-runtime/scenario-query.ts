import { type AgentScenario } from '@ai-werewolf/shared';
import { renderActionLine } from '../evaluation/action-catalog';

/**
 * 语义检索的场景 query 构建。
 *
 * 目标是与 lesson 的 trigger 语义对齐：trigger 是「我是预言家、首夜验出金水、场上已有人起跳」
 * 这类局面描述，query 用「身份 + 场景 + 最近可见事件」拼出当前局面，交给 embedding 做余弦匹配。
 */

/** 角色中文名。trigger 里角色以中文出现（「我是预言家」），query 用英文会拉低相似度 */
const ROLE_LABELS: Record<string, string> = {
  villager: '平民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  idiot: '白痴',
  werewolf: '狼人',
  wolf_king: '狼王',
};

/** 场景中文名 */
const SCENARIO_LABELS: Record<AgentScenario, string> = {
  vote: '投票',
  day_speech: '白天发言',
  night_action: '夜间行动',
  last_words: '遗言',
  sheriff_decide_order: '警长决定发言顺序',
};

/** 进 query 的最近事件条数上限，防 query 过长稀释关键信号 */
const QUERY_EVENT_LIMIT = 20;

export interface ScenarioQueryEvent {
  actionType: string;
  visibility: string;
  content: unknown;
}

export function buildScenarioQuery(input: {
  role: string | null;
  scenario: AgentScenario;
  day: number;
  events: ScenarioQueryEvent[];
}): string {
  const roleLabel = input.role ? (ROLE_LABELS[input.role] ?? input.role) : '';
  const scenarioLabel = SCENARIO_LABELS[input.scenario];

  const lines = input.events
    .slice(-QUERY_EVENT_LIMIT)
    .map((e) =>
      renderActionLine(e.actionType, (e.content as Record<string, unknown>) ?? {}, e.visibility),
    )
    .filter((line): line is string => line !== null);

  return [roleLabel ? `我是${roleLabel}` : '', `第${input.day}天${scenarioLabel}`, ...lines]
    .filter(Boolean)
    .join('，');
}
