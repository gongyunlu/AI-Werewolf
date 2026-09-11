import { ACTION_TYPES } from '@ai-werewolf/shared';
import { getHistoricallyVisibleEvents } from '../game-engine/rules/visibility';
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
  deathDay: number | null; // 还原观察当时的权限，保留死亡前已知的信息
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
  // 评价的是查谁；查验结果在决策完成后才产生。
  if (d.actionType === ACTION_TYPES.SEER_CHECK)
    return `预言家选择查验 ${d.targetSeatNo}号位（结果未知）`;
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
    deathDay,
    teammates,
    decision,
    events,
  } = input;

  const visibleEvents = getHistoricallyVisibleEvents(
    { id: playerId, role: playerRole, deathDay },
    events.filter((e) => e.sequence < decision.sequence),
  );
  const contextLines = visibleEvents
    .filter((e) => {
      // 投票是并发「同时举票」：评估投票决策时排除本轮及之后的投票，保留同 day 已结束轮次，避免视角泄漏假象
      if (
        decision.actionType === ACTION_TYPES.VOTE &&
        e.actionType === ACTION_TYPES.VOTE &&
        e.day === decision.day &&
        Number(e.content.voteRound ?? 0) >= Number(decision.content?.voteRound ?? 0)
      ) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => a.sequence - b.sequence)
    .slice(-CONTEXT_EVENT_LIMIT)
    .map((e) => renderActionLine(e.actionType, e.content ?? {}, e.visibility, { fullSpeech: true }))
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
 * 调用方截断到待评发言，逐事件还原当时可见性（女巫用药后不再获得新刀口）。
 * 待评发言取原文并标号，其他发言保留完整正文作为历史证据。
 */
export function buildSpeechJudgePromptVariables(input: SpeechJudgePromptInput): {
  variables: SpeechJudgePromptVariables;
  targets: SpeechJudgeTarget[];
} {
  const { playerId, playerSeatNo, playerRole, playerFaction, deathDay, teammates, events } = input;

  const lines: string[] = [];
  const targets: SpeechJudgeTarget[] = [];

  for (const e of getHistoricallyVisibleEvents(
    { id: playerId, role: playerRole, deathDay },
    events,
  ).toSorted((a, b) => a.sequence - b.sequence)) {
    const dayPrefix = e.day != null ? `第${e.day}天 ` : '';
    const isOwnSpeech = e.actionType === ACTION_TYPES.SPEECH && e.actorId === playerId;

    if (isOwnSpeech) {
      const speech = typeof e.content.speech === 'string' ? e.content.speech.trim() : '';
      if (speech) {
        targets.push({ index: targets.length + 1, sequence: e.sequence, day: e.day });
        lines.push(`[发言#${targets.length}] ${dayPrefix}我的发言：${speech}`);
      }
    } else {
      const line = renderActionLine(e.actionType, e.content ?? {}, e.visibility, {
        fullSpeech: true,
      });
      if (line) lines.push(`${dayPrefix}${line}`);
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

/**
 * 反思（refine）阶段的 user 文本：原始评估上下文 + 初评结果。
 *
 * 反思指令在 refine-system prompt 里，这里只负责把「初评时看到的上下文」和「初评结果」
 * 一并交给评审员复核，修正后的输出 schema 与初评一致。
 */
export function buildRefineUser(firstUser: string, firstOutput: unknown): string {
  return [
    '【原始评估上下文】',
    firstUser,
    '',
    '【初评结果】',
    JSON.stringify(firstOutput, null, 2),
  ].join('\n');
}
