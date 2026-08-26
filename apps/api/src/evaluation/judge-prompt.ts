import { ACTION_TYPES, SEER_CHECK_RESULTS } from '@ai-werewolf/shared';
import { getVisibleVisibilitiesForRole } from '../game-engine/rules/visibility';
import {
  FALLBACK_TEMPLATES,
  PROMPT_NAMES,
  renderTemplate,
} from '../observability/prompt-templates';

/** 事件输入（judge-prompt 只消费渲染所需字段，不依赖 Prisma 类型） */
export interface JudgeEventInput {
  sequence: number;
  day: number | null;
  actionType: string;
  visibility: string;
  actorId: string | null;
  content: Record<string, unknown>;
}

/** 待评估的决策 */
export interface JudgeDecisionInput {
  sequence: number;
  actionType: string;
  day: number;
  targetSeatNo: number | null;
  thinking?: string;
}

/** 构建 judge prompt 的输入 */
export interface JudgePromptInput {
  playerId: string;
  playerSeatNo: number | null;
  playerRole: string;
  playerFaction: string;
  isAlive: boolean; // 决策时点是否存活（影响女巫刀口可见性）
  teammates: number[]; // 同阵营队友座位号（狼人互为队友）
  decision: JudgeDecisionInput;
  events: JudgeEventInput[]; // 全量事件，内部按 sequence < decision.sequence 截断
}

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

const ACTION_LABELS: Record<string, string> = {
  [ACTION_TYPES.SEER_CHECK]: '查验',
  [ACTION_TYPES.WITCH_SAVE]: '使用解药',
  [ACTION_TYPES.WITCH_POISON]: '使用毒药',
  [ACTION_TYPES.VOTE]: '投票',
};

/** 单条历史事件 → 可读行；不相关的返回 null */
function renderEventLine(e: JudgeEventInput): string | null {
  const c = e.content ?? {};
  switch (e.actionType) {
    case ACTION_TYPES.WOLF_KILL:
      return c.targetSeatNo != null ? `狼人刀了 ${c.targetSeatNo}号位` : '狼人空刀';
    case ACTION_TYPES.SEER_CHECK: {
      const result =
        c.result === SEER_CHECK_RESULTS.WEREWOLF
          ? '狼人'
          : c.result === SEER_CHECK_RESULTS.GOOD
            ? '好人'
            : String(c.result);
      return `预言家查验 ${c.targetSeatNo}号位 → ${result}`;
    }
    case ACTION_TYPES.WITCH_SAVE:
      return c.saved ? `女巫使用解药救了 ${c.targetSeatNo}号位` : '女巫未使用解药';
    case ACTION_TYPES.WITCH_POISON:
      return c.used ? `女巫使用毒药毒了 ${c.targetSeatNo}号位` : '女巫未使用毒药';
    case ACTION_TYPES.VOTE:
      return `${c.voterSeatNo}号位投票给 ${c.targetSeatNo}号位`;
    case ACTION_TYPES.PLAYER_DIED: {
      const deaths = Array.isArray(c.deaths)
        ? (c.deaths as Array<{ seatNo: number }>).map((d) => `${d.seatNo}号位`).join('、')
        : '';
      return deaths ? `死亡公告：${deaths}` : null;
    }
    case ACTION_TYPES.PLAYER_EXECUTED:
      return c.targetSeatNo != null ? `放逐 ${c.targetSeatNo}号位` : null;
    default:
      return null;
  }
}

/** 决策 → 可读描述 */
function renderDecision(d: JudgeDecisionInput): string {
  const label = ACTION_LABELS[d.actionType] ?? d.actionType;
  const target =
    d.targetSeatNo != null && d.targetSeatNo > 0 ? `${d.targetSeatNo}号位` : '放弃行动';
  return `${label}（目标：${target}）`;
}

/**
 * 构造 judge prompt
 *
 * 只包含决策时点之前该角色可见的事件，避免引入上帝视角信息
 */
/** judge prompt 的渲染变量（纯计算，与模板文本解耦） */
export type JudgePromptVariables = {
  identity: string;
  contextLines: string;
  decisionText: string;
  thinking: string;
};

/**
 * 计算 judge prompt 的渲染变量（视角还原 + 事件渲染 + 决策描述）。
 *
 * 与模板文本解耦：变量计算保持纯函数可单测，模板渲染由调用方走 PromptService。
 */
export function buildJudgePromptVariables(input: JudgePromptInput): JudgePromptVariables {
  const {
    playerId,
    playerSeatNo,
    playerRole,
    playerFaction,
    isAlive,
    teammates,
    decision,
    events,
  } = input;

  // 女巫是否已用过解药：只看决策之前的 witch_save（本人）
  const hasUsedAntidote = events.some(
    (e) =>
      e.sequence < decision.sequence &&
      e.actionType === ACTION_TYPES.WITCH_SAVE &&
      e.actorId === playerId,
  );

  const visible = getVisibleVisibilitiesForRole({
    role: playerRole,
    isAlive,
    hasUsedAntidote,
  });

  const contextLines = events
    .filter((e) => {
      if (e.sequence >= decision.sequence) return false;
      if (!visible.includes(e.visibility)) return false;
      // 投票是并发「同时举票」：评估投票决策时排除同轮（同 day）其他投票，避免视角泄漏假象
      if (
        decision.actionType === ACTION_TYPES.VOTE &&
        e.actionType === ACTION_TYPES.VOTE &&
        e.day === decision.day
      ) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => a.sequence - b.sequence)
    .slice(-20) // 只保留最近 20 条，防 prompt 爆炸
    .map(renderEventLine)
    .filter((line): line is string => line !== null);

  const roleLabel = ROLE_LABELS[playerRole] ?? playerRole;
  const identity =
    `座位号 ${playerSeatNo ?? '?'}、角色 ${roleLabel}（${playerFaction}）` +
    (teammates.length > 0 ? `、队友座位号 [${teammates.join(', ')}]` : '');

  return {
    identity,
    contextLines: contextLines.length > 0 ? contextLines.join('\n') : '（无可见信息）',
    decisionText: renderDecision(decision),
    thinking: decision.thinking ? `玩家当时的思考过程：${decision.thinking}` : '',
  };
}

/**
 * 构造 judge prompt
 */
export function buildJudgePrompt(input: JudgePromptInput): { system: string; user: string } {
  const variables = buildJudgePromptVariables(input);
  return {
    system: renderTemplate(FALLBACK_TEMPLATES[PROMPT_NAMES.judgeSystem]),
    user: renderTemplate(FALLBACK_TEMPLATES[PROMPT_NAMES.judgeUser], variables),
  };
}
