import { ACTION_TYPES } from '@ai-werewolf/shared';
import { getVisibleVisibilitiesForRole } from '../game-engine/rules/visibility';
import { getActionLabel, renderActionLine } from './action-catalog';
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
  /** 当前决策事件的原始负载，供无 target 的技能（如警长顺序）按目录表准确渲染 */
  content?: Record<string, unknown>;
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

/**
 * 决策上下文保留的事件条数上限，防 prompt 爆炸。
 * 发言已纳入上下文渲染（此前完全缺失，judge 评投票时看不到当天讨论），
 * 6 人局一天约 20 条事件，取 40 保证跨天可见。
 */
const CONTEXT_EVENT_LIMIT = 40;

/** 决策 → 可读描述 */
function renderDecision(d: JudgeDecisionInput): string {
  if (d.content) {
    const rendered = renderActionLine(d.actionType, d.content, 'public');
    if (rendered) return rendered;
  }
  const label = getActionLabel(d.actionType);
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
      e.actorId === playerId &&
      e.content.saved === true,
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
    .slice(-CONTEXT_EVENT_LIMIT)
    .map((e) => renderActionLine(e.actionType, e.content ?? {}, e.visibility))
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

/** 发言批量评估的输入 */
export interface SpeechJudgePromptInput {
  playerId: string;
  playerSeatNo: number | null;
  playerRole: string;
  playerFaction: string;
  deathDay: number | null; // 逐条事件判断存活，影响女巫刀口可见性
  teammates: number[];
  events: JudgeEventInput[]; // 全量事件，内部按该玩家逐时刻的可见性过滤
}

/** 时间线里被标号的一条自己的发言 */
export interface SpeechJudgeTarget {
  index: number; // 1-based，对应 prompt 里的 [发言#n]
  sequence: number;
  day: number | null;
}

export type SpeechJudgePromptVariables = {
  identity: string;
  timeline: string;
  speechCount: string;
};

/**
 * 构建发言批量评估的渲染变量。
 *
 * 与单决策评估的区别：跨越整局而非截断到某一时点，因此可见性要逐条事件重算
 * （女巫用掉解药后即失去刀口频道，玩家死亡后不再获得新信息）。
 * 自己的发言取原文并标号，他人的发言走目录表的截断预览。
 */
export function buildSpeechJudgePromptVariables(input: SpeechJudgePromptInput): {
  variables: SpeechJudgePromptVariables;
  targets: SpeechJudgeTarget[];
} {
  const { playerId, playerSeatNo, playerRole, playerFaction, deathDay, teammates, events } = input;

  const lines: string[] = [];
  const targets: SpeechJudgeTarget[] = [];
  let hasUsedAntidote = false;

  for (const e of events.toSorted((a, b) => a.sequence - b.sequence)) {
    const isAlive = deathDay === null || (e.day ?? 0) <= deathDay;
    const visible = getVisibleVisibilitiesForRole({ role: playerRole, isAlive, hasUsedAntidote });

    if (visible.includes(e.visibility)) {
      const dayPrefix = e.day != null ? `第${e.day}天 ` : '';
      const isOwnSpeech = e.actionType === ACTION_TYPES.SPEECH && e.actorId === playerId;

      if (isOwnSpeech) {
        const speech = typeof e.content.speech === 'string' ? e.content.speech.trim() : '';
        if (speech) {
          targets.push({ index: targets.length + 1, sequence: e.sequence, day: e.day });
          lines.push(`[发言#${targets.length}] ${dayPrefix}我的发言：${speech}`);
        }
      } else {
        const line = renderActionLine(e.actionType, e.content ?? {}, e.visibility);
        if (line) lines.push(`${dayPrefix}${line}`);
      }
    }

    // 解药状态在事件之后才生效：解药事件本身对女巫可见
    if (
      e.actionType === ACTION_TYPES.WITCH_SAVE &&
      e.actorId === playerId &&
      e.content.saved === true
    ) {
      hasUsedAntidote = true;
    }
  }

  const roleLabel = ROLE_LABELS[playerRole] ?? playerRole;
  const identity =
    `座位号 ${playerSeatNo ?? '?'}、角色 ${roleLabel}（${playerFaction}）` +
    (teammates.length > 0 ? `、队友座位号 [${teammates.join(', ')}]` : '');

  return {
    variables: {
      identity,
      timeline: lines.length > 0 ? lines.join('\n') : '（无可见信息）',
      speechCount: String(targets.length),
    },
    targets,
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
