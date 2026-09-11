import { ACTION_TYPES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import { renderActionLine } from '../evaluation/action-catalog';

/** 事件输入（只消费渲染所需字段，不依赖 Prisma 类型） */
export interface ReviewEventInput {
  sequence: number;
  day: number | null;
  actionType: string;
  visibility: string;
  actorId: string | null;
  content: Record<string, unknown>;
}

/** 玩家的真实身份（复盘是开眼的，与 judge 的视角还原相反） */
export interface ReviewPlayer {
  playerId: string;
  seatNo: number | null;
  agentName: string;
  role: string;
  faction: string;
  deathDay: number | null;
  isWinner: boolean;
}

/** 一条已落库的行为评分 */
export interface JudgmentInput {
  playerId: string;
  actionType: string;
  day: number;
  targetSeatNo: number | null;
  verdict: string;
  score: number;
  reasoning: string | null;
}

export interface GameReviewPromptInput {
  winnerFaction: string;
  totalDays: number;
  players: ReviewPlayer[];
  events: ReviewEventInput[];
  /** 局内已生成的发言摘要，用于压缩上下文；缺摘要的天数回落到原文截断 */
  speechSummaries: Array<{ day: number; seatNo: number; summary: string }>;
  judgments: JudgmentInput[];
}

export type GameReviewVariables = {
  outcome: string;
  roster: string;
  timeline: string;
  weakDecisions: string;
};

/** 无摘要时发言原文在时间线里的保留长度 */
const SPEECH_FALLBACK_LIMIT = 150;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function seatLabel(p: ReviewPlayer): string {
  return `${p.seatNo ?? '?'}号位(${p.agentName}/${p.role})`;
}

/**
 * 构建对局级开眼复盘的渲染变量。
 *
 * 与 judge 相反：不做 visibility 过滤，全量事件带真实身份，这样复盘才能指出「谁在什么时候骗了谁」。
 */
export function buildGameReviewVariables(input: GameReviewPromptInput): GameReviewVariables {
  const { winnerFaction, totalDays, players, events, speechSummaries, judgments } = input;

  const byPlayerId = new Map(players.map((p) => [p.playerId, p]));
  const summaryByKey = new Map(speechSummaries.map((s) => [`${s.day}:${s.seatNo}`, s.summary]));
  const emittedSummaryKeys = new Set<string>();
  const summaryLines: string[] = [];

  const timeline = events
    .toSorted((a, b) => a.sequence - b.sequence)
    .map((e) => {
      const dayPrefix = e.day != null ? `第${e.day}天 ` : '';

      if (e.actionType === ACTION_TYPES.SPEECH) {
        const speech = typeof e.content.speech === 'string' ? e.content.speech.trim() : '';
        if (!speech) return null;
        const actor = e.actorId ? byPlayerId.get(e.actorId) : undefined;
        const who = actor ? seatLabel(actor) : `${e.content.seatNo ?? '?'}号位`;
        const kind = e.visibility === VISIBILITY_TYPES.WOLF ? '狼队商议' : '发言';
        // speechSummaries 只由公开发言生成，不能拿它覆盖同日同座位的狼队私聊。
        const summaryKey =
          e.visibility === VISIBILITY_TYPES.PUBLIC && actor?.seatNo != null && e.day != null
            ? `${e.day}:${actor.seatNo}`
            : undefined;
        const summary = summaryKey ? summaryByKey.get(summaryKey) : undefined;
        // 整日摘要单列，不能放在第一条发言的位置冒充当时的原话。
        if (summary && summaryKey) {
          if (emittedSummaryKeys.has(summaryKey)) return null;
          emittedSummaryKeys.add(summaryKey);
          summaryLines.push(`${dayPrefix}${who}公开发言摘要：${summary}`);
          return null;
        }
        return `${dayPrefix}${who}${kind}：${truncate(speech, SPEECH_FALLBACK_LIMIT)}`;
      }

      const line = renderActionLine(e.actionType, e.content ?? {}, e.visibility);
      return line ? `${dayPrefix}${line}` : null;
    })
    .filter((line): line is string => line !== null);

  if (summaryLines.length) {
    timeline.push(
      '【公开发言摘要：按日聚合的赛后概括，不是逐字原话，不用于还原某次发言时点的已知信息】',
      ...summaryLines,
    );
  }

  const roster = players
    .toSorted((a, b) => (a.seatNo ?? 0) - (b.seatNo ?? 0))
    .map((p) => {
      const fate = p.deathDay === null ? '存活到终局' : `第${p.deathDay}天出局`;
      return `${seatLabel(p)} 阵营=${p.faction} ${fate} ${p.isWinner ? '胜' : '负'}`;
    })
    .join('\n');

  // 只列出被判为非 good 的行为：复盘要解释的是失误，good 的行为无需逐条重述
  const weak = judgments
    .filter((j) => j.verdict !== 'good')
    .toSorted((a, b) => a.day - b.day || a.score - b.score)
    .map((j) => {
      const actor = byPlayerId.get(j.playerId);
      const target = j.targetSeatNo != null ? ` → ${j.targetSeatNo}号位` : '';
      return `第${j.day}天 ${actor ? seatLabel(actor) : j.playerId} ${j.actionType}${target}｜${j.verdict}/${j.score}：${j.reasoning}`;
    });

  return {
    outcome: `${winnerFaction} 阵营获胜，共 ${totalDays} 天`,
    roster,
    timeline: timeline.length > 0 ? timeline.join('\n') : '（无事件）',
    weakDecisions:
      weak.length > 0 ? weak.join('\n') : '（没有可用的不佳行为记录：可能全部为 good，或尚未评分）',
  };
}

/** 玩家局内对他人的信任评分与真实身份的偏差 */
export interface TrustMisread {
  seatNo: number;
  agentName: string;
  trustScore: number;
  suspicious: boolean;
  actualFaction: string;
  relationship: string | null;
}

export interface ReflectionPromptInput {
  me: ReviewPlayer;
  /** 同桌对手的真实身份（复盘开眼），也是 playerModels 里 agentName 的合法取值域 */
  opponents: Array<{ agentName: string; seatNo: number | null; role: string; faction: string }>;
  review: { narrative: string; turningPoints: Array<{ day: number; description: string }> };
  myJudgments: JudgmentInput[];
  /** 只放自己的发言与自己的思考，他人的内心推理一律不得进入 */
  mySpeeches: Array<{
    day: number | null;
    phase: string;
    visibility: string;
    speech: string;
    thinking?: string;
  }>;
  trustMisreads: TrustMisread[];
  performance: {
    survivalDays: number;
    isWinner: boolean;
    voteAccuracy: number | null;
    speechCount: number;
  } | null;
  existingModels: Array<{ agentName: string; content: string }>;
}

export type ReflectionVariables = {
  identity: string;
  opponents: string;
  review: string;
  weakActions: string;
  trustMisreads: string;
  mySpeeches: string;
  performance: string;
  existingModels: string;
};

/**
 * 构建玩家级反思的渲染变量。
 *
 * 三段输入：对局级复盘（替代各自重新消化整局）、客观误差（judge 评分 + 信任误判）、我的视角。
 */
export function buildReflectionVariables(input: ReflectionPromptInput): ReflectionVariables {
  const { me, opponents, review, myJudgments, mySpeeches, trustMisreads, performance } = input;

  const turningPoints = review.turningPoints
    .map((t) => `- 第${t.day}天：${t.description}`)
    .join('\n');

  const weakActions = myJudgments
    .filter((j) => j.verdict !== 'good')
    .toSorted((a, b) => a.day - b.day || a.score - b.score)
    .map((j) => {
      const target = j.targetSeatNo != null ? ` → ${j.targetSeatNo}号位` : '';
      return `第${j.day}天 ${j.actionType}${target}｜${j.verdict}/${j.score}：${j.reasoning}`;
    });

  // 信任分是相对于玩家自身阵营的：狼人高信任已知队友是正确的一手信息，
  // 不能套用好人视角的「信狼=误判」规则。relationship=teammate 同样视为同阵营。
  const misreads = trustMisreads
    .filter((t) => {
      const isAlly = t.relationship === 'teammate' || t.actualFaction === me.faction;
      return isAlly ? t.trustScore < 40 || t.suspicious : t.trustScore >= 60 || !t.suspicious;
    })
    .map((t) => {
      const relationship = t.relationship ? `，一手关系 ${t.relationship}` : '';
      return `${t.seatNo}号位(${t.agentName}) 我给的信任分 ${t.trustScore}${t.suspicious ? '（标记为可疑）' : ''}，真实阵营 ${t.actualFaction}${relationship}`;
    });

  const speeches = mySpeeches.map((s) => {
    const thinking = s.thinking ? `\n  （当时的思考：${truncate(s.thinking, 300)}）` : '';
    return `第${s.day ?? '?'}天 [阶段=${s.phase}，可见性=${s.visibility}]：${s.speech}${thinking}`;
  });

  const perf = performance
    ? `存活 ${performance.survivalDays} 天、${performance.isWinner ? '获胜' : '落败'}、发言 ${performance.speechCount} 次` +
      (performance.voteAccuracy !== null
        ? `、投票命中狼人比例 ${(performance.voteAccuracy * 100).toFixed(0)}%`
        : '')
    : '（无统计数据）';

  const existingModels = input.existingModels.map((m) => `【${m.agentName}】${m.content}`);

  return {
    identity: `${me.seatNo ?? '?'}号位、角色 ${me.role}（${me.faction}）、${me.isWinner ? '本局获胜' : '本局落败'}、${me.deathDay === null ? '存活到终局' : `第${me.deathDay}天出局`}`,
    opponents: opponents
      .toSorted((a, b) => (a.seatNo ?? 0) - (b.seatNo ?? 0))
      .map((o) => `${o.seatNo ?? '?'}号位 ${o.agentName}：真实身份 ${o.role}（${o.faction}）`)
      .join('\n'),
    review: `${review.narrative}${turningPoints ? `\n\n关键转折：\n${turningPoints}` : ''}`,
    weakActions:
      weakActions.length > 0
        ? weakActions.join('\n')
        : '（没有可用的不佳行为记录：可能全部为 good，或尚未评分）',
    trustMisreads: misreads.length > 0 ? misreads.join('\n') : '（没有明显的识人偏差）',
    mySpeeches: speeches.length > 0 ? speeches.join('\n') : '（本局没有发言）',
    performance: perf,
    existingModels: existingModels.length > 0 ? existingModels.join('\n') : '（此前没有对手建模）',
  };
}
