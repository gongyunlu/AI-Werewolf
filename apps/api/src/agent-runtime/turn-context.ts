import type { AgentScenario } from '@ai-werewolf/shared';

export interface TurnPosition {
  day: number;
  phase: string;
  round: number;
  aliveSeats: number[];
  order?: number[];
  completedSeats?: number[];
  skippedSeats?: number[];
}

/** 引擎提供时点与当前合法任务；历史事实由同一授权事件投影读取。 */
export interface TurnContextRequest {
  phaseInstanceId?: string;
  actionOrdinal?: number;
  visibleThrough?: number;
  gameId: string;
  playerId: string;
  scenario: AgentScenario;
  actionType: string;
  position: TurnPosition;
  additionalContext?: string;
}

interface VisibleEvent {
  id: string;
  sequence: number;
  day: number | null;
  phase?: string;
  actorId?: string | null;
  actionType: string;
  visibility: string;
  content: unknown;
}

/**
 * 事件中已提交的本人理由。只有本人动作才带私有理由；
 * 他人的 thinking、供应商 reasoning 和未提交候选都不在此列。
 */
export function ownThinkingFromEvent(event: VisibleEvent, playerId: string): string | undefined {
  if (event.actorId !== playerId) return undefined;
  const thinking = (event.content as Record<string, unknown> | null)?.thinking;
  return typeof thinking === 'string' && thinking.trim() ? thinking : undefined;
}

export function buildTurnContext(input: {
  playerId: string;
  seatNo: number | null;
  roster: Array<{ seatNo: number | null; displayName: string }>;
  actionType: string;
  events: VisibleEvent[];
  position: TurnPosition;
  /** 事件未保存理由时，按事件 id 补充的本人私有理由（来自同 game/player/event 的决策快照）。 */
  ownReasonings?: ReadonlyMap<string, string>;
}): string {
  const { events, position } = input;
  const lines = [
    '【引擎提供的回合事实】',
    '你是' + input.seatNo + '号；当前第' + position.day + '天。',
    '本局公开座位与姓名：' +
      input.roster
        .toSorted((a, b) => (a.seatNo ?? 0) - (b.seatNo ?? 0))
        .map((player) => `${player.seatNo}号（${player.displayName}）`)
        .join('、'),
    '阶段：' + position.phase + '；动作：' + input.actionType + '；轮次：' + position.round + '。',
    '存活玩家：' + (position.aliveSeats.join('、') || '无'),
    '可见事件截止序号：' + Math.max(0, ...events.map((e) => e.sequence)),
  ];
  if (position.order) {
    const index = position.order.indexOf(input.seatNo!);
    lines.push('本轮顺序：' + position.order.join(' → '));
    lines.push('本轮已完成发言：' + (position.completedSeats?.join('、') || '无'));
    lines.push('本轮因失败或跳过而未完成：' + (position.skippedSeats?.join('、') || '无'));
    lines.push(
      '你之后尚未轮到：' +
        (index >= 0 ? position.order.slice(index + 1).join('、') || '无' : '不适用'),
    );
    lines.push('尚未轮到不代表沉默、拒绝发言或隐藏身份。只有已完成的发言可以被引用。');
  }
  lines.push('【已提交的可见记录：按事件顺序，私有信息不可当作他人已知】');
  let hasOwnSpeech = false;
  for (const event of events) {
    const c = (event.content ?? {}) as Record<string, unknown>;
    const turn = c.turn as { phase?: string; round?: number } | undefined;
    const own = event.actorId === input.playerId;
    const speech = event.actionType === 'speech' && typeof c.speech === 'string';
    const fact = speech
      ? (own ? '你本人' : '') +
        c.seatNo +
        '号发言原文' +
        (turn?.round != null || c.round != null ? '（第' + (turn?.round ?? c.round) + '轮）' : '') +
        '：' +
        c.speech
      : formatVisibleAction(event);
    if (!fact) continue;
    if (speech && own) hasOwnSpeech = true;
    const phaseLabels: Record<string, string> = {
      night: '夜间',
      day_announce: '天亮公告',
      speech: c.sceneType === 'last_words' ? '遗言' : '公开发言',
      vote: '投票',
      execute: '放逐',
    };
    const phase = turn?.phase ?? phaseLabels[event.phase ?? ''] ?? event.phase ?? '阶段未标注';
    lines.push(
      '事件#' +
        event.sequence +
        ' 第' +
        event.day +
        '天 ' +
        phase +
        ' [' +
        event.visibility +
        ']：' +
        (!speech && own ? '你本人已提交：' : '') +
        fact,
    );
    if (own) {
      const reasoning =
        ownThinkingFromEvent(event, input.playerId) ?? input.ownReasonings?.get(event.id);
      if (reasoning) lines.push('[你的私有理由·当时] ' + reasoning);
    }
  }
  if (!hasOwnSpeech) lines.push('截至当前没有你的已提交发言。');
  lines.push(
    '发言原文只证明玩家说过这些话，不代表真实身份或真实查验；自称身份、报验和推测不自动成为事实。跨局经验不能证明本局发生了某事。',
  );
  lines.push(
    '标注「你的私有理由·当时」的内容只代表你当时提交动作时的判断和策略，不是当前事实，也不要求你现在继续坚持。',
  );
  return lines.join('\n');
}

/** 输入必须已经按玩家权限过滤；只取行动字段，不复制事件内的私有推理或整份 metadata。 */
function formatVisibleAction(event: VisibleEvent): string | undefined {
  const c = (event.content ?? {}) as Record<string, unknown>;
  switch (event.actionType) {
    case 'judge_announce':
      return typeof c.content === 'string' ? c.content : undefined;
    case 'vote':
      return `第${c.voteRound ?? 0}轮投票：${c.voterSeatNo}号投给${c.targetSeatNo}号（0表示弃权）`;
    case 'seer_check':
      return `查验${c.targetSeatNo}号，结果：${c.result}`;
    case 'wolf_kill':
      return `狼刀目标：${c.targetSeatNo ?? '无'}号`;
    case 'witch_save':
      return c.saved === true ? `使用解药救${c.targetSeatNo}号` : '未使用解药';
    case 'witch_poison':
      return c.used === true ? `使用毒药毒${c.targetSeatNo}号` : '未使用毒药';
    case 'wolf_explode':
      return `${c.seatNo}号选择${c.action}（询问结果，是否执行以公开公告为准）`;
    case 'wolf_proposal':
      return `${c.seatNo}号提议刀${c.targetSeatNo}号（提案不等于最终落刀）`;
    case 'peaceful_night':
      return '昨夜平安夜';
    case 'player_died':
      return Array.isArray(c.deaths)
        ? `死亡公告：${c.deaths.map((death: { seatNo?: number }) => `${death.seatNo}号`).join('、')}`
        : undefined;
    case 'player_executed':
      return `放逐公告：${c.targetSeatNo}号`;
    case 'sheriff_decide_order':
      return `警长${c.sheriffSeatNo}号选择${c.direction === 'left' ? '左手' : '右手'}方向开始发言`;
    case 'speech_order_determined':
      return Array.isArray(c.speechOrder)
        ? `已公布的发言顺序：${c.speechOrder.join(' → ')}`
        : undefined;
    default:
      return undefined;
  }
}
