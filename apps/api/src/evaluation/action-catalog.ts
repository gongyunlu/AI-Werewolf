import { ACTION_TYPES, SEER_CHECK_RESULTS, VISIBILITY_TYPES } from '@ai-werewolf/shared';

/** 事件 content JSON（各 EventWriter 方法写入的形状） */
type EventContent = Record<string, unknown>;

/**
 * 单个行为在评估链路里的三项能力。
 *
 * 三项分散时新增角色技能要改三处，漏一处会静默失效：
 * 漏 judgeable → 该技能永远没有质量分；漏 label → 决策描述显示英文原始值；
 * 漏 render → 该技能在所有人的决策上下文里隐形，judge 无从判断信息利用率。
 */
interface ActionMeta {
  /** 决策描述文案；不填则退化为 actionType 原始值 */
  label?: string;
  /**
   * 该事件是否作为独立决策逐条送评。
   * 不填 = 不评（系统播报与流程事件）；填函数以排除「未用药」这类空行动。
   * 发言不在此列：队列按玩家调度，每条发言单独评分。
   */
  judgeable?: (content: EventContent) => boolean;
  /** 渲染成决策上下文的一行；返回 null 表示该事件不进上下文 */
  render?: (content: EventContent, visibility: string) => string | null;
}

/** 上下文里的发言只保留开头，避免单条挤占整个窗口 */
const SPEECH_PREVIEW_LIMIT = 120;

function preview(text: string): string {
  return text.length > SPEECH_PREVIEW_LIMIT ? `${text.slice(0, SPEECH_PREVIEW_LIMIT)}…` : text;
}

/**
 * 行为目录：新增角色技能只需在此追加一行。
 *
 * 未列出的 actionType 走缺省行为（不送评、文案取原始值、不进上下文）——
 * 未接入游戏引擎的技能不预置条目，避免臆测其 content 形状。
 */
const ACTION_CATALOG: Record<string, ActionMeta> = {
  [ACTION_TYPES.SPEECH]: {
    label: '发言',
    render: (c, visibility) => {
      // 只渲染发言正文：content.thinking 是该玩家的内心推理，渲染出去等于把他人思考泄漏给 judge
      const speech = typeof c.speech === 'string' ? c.speech.trim() : '';
      if (!speech) return null;
      const kind = visibility === VISIBILITY_TYPES.WOLF ? '狼队商议' : '发言';
      return `${c.seatNo}号位${kind}：${preview(speech)}`;
    },
  },

  [ACTION_TYPES.VOTE]: {
    label: '投票',
    judgeable: (c) => typeof c.targetSeatNo === 'number' && c.targetSeatNo > 0,
    render: (c) =>
      c.targetSeatNo === 0
        ? `${c.voterSeatNo}号位弃票`
        : `${c.voterSeatNo}号位投票给 ${c.targetSeatNo}号位`,
  },

  [ACTION_TYPES.SPEECH_ORDER_DETERMINED]: {
    render: (c) => (typeof c.message === 'string' ? c.message : null),
  },

  [ACTION_TYPES.SHERIFF_DECIDE_ORDER]: {
    label: '警长决定发言顺序',
    judgeable: () => true,
    render: (c) => {
      const direction = c.direction === 'left' ? '左手（逆时针）' : '右手（顺时针）';
      return `${c.sheriffSeatNo}号位警长决定从${direction}开始发言`;
    },
  },

  [ACTION_TYPES.SEER_CHECK]: {
    label: '查验',
    judgeable: () => true,
    render: (c) => {
      const result =
        c.result === SEER_CHECK_RESULTS.WEREWOLF
          ? '狼人'
          : c.result === SEER_CHECK_RESULTS.GOOD
            ? '好人'
            : String(c.result);
      return `预言家查验 ${c.targetSeatNo}号位 → ${result}`;
    },
  },

  [ACTION_TYPES.WITCH_SAVE]: {
    label: '使用解药',
    judgeable: (c) =>
      c.saved === true ||
      (c.saved === false && typeof c.thinking === 'string' && c.thinking.trim().length > 0),
    render: (c) => (c.saved ? `女巫使用解药救了 ${c.targetSeatNo}号位` : '女巫未使用解药'),
  },

  [ACTION_TYPES.WITCH_POISON]: {
    label: '使用毒药',
    judgeable: (c) =>
      c.used === true ||
      (c.used === false && typeof c.thinking === 'string' && c.thinking.trim().length > 0),
    render: (c) => (c.used ? `女巫使用毒药毒了 ${c.targetSeatNo}号位` : '女巫未使用毒药'),
  },

  // 狼刀按狼队集体决策送评，结果保存为团队分。
  [ACTION_TYPES.WOLF_KILL]: {
    label: '狼刀',
    judgeable: () => true,
    render: (c) => (c.targetSeatNo != null ? `狼人刀了 ${c.targetSeatNo}号位` : '狼人空刀'),
  },

  [ACTION_TYPES.WOLF_EXPLODE]: {
    label: '自爆选择',
    judgeable: (c) => c.action === 'explode' || c.action === 'hold',
    render: (c) => `${c.seatNo}号位选择${c.action === 'explode' ? '自爆' : '保留白天'}`,
  },
  [ACTION_TYPES.WOLF_PROPOSAL]: {
    render: (c) => `${c.seatNo}号位提议刀 ${c.targetSeatNo}号位`,
  },

  [ACTION_TYPES.IDIOT_FLIP]: {
    label: '白痴翻牌',
    render: (c) => `${c.seatNo}号位白痴翻牌，免疫放逐`,
  },

  [ACTION_TYPES.PLAYER_DIED]: {
    render: (c) => {
      const deaths = Array.isArray(c.deaths)
        ? (c.deaths as Array<{ seatNo: number }>).map((d) => `${d.seatNo}号位`).join('、')
        : '';
      return deaths ? `死亡公告：${deaths}` : null;
    },
  },

  [ACTION_TYPES.PEACEFUL_NIGHT]: {
    render: () => '死亡公告：平安夜',
  },

  [ACTION_TYPES.PLAYER_EXECUTED]: {
    render: (c) => (c.targetSeatNo != null ? `放逐 ${c.targetSeatNo}号位` : null),
  },

  [ACTION_TYPES.JUDGE_ANNOUNCE]: {
    // 法官播报的正文在 content.content（其余字段是 metadata），渲染正文即可
    render: (c) => (typeof c.content === 'string' && c.content.trim() ? c.content : null),
  },
};

/** 该事件是否作为独立决策送评（「不用药」这类空行动不算决策） */
export function isJudgeableAction(actionType: string, content: EventContent): boolean {
  return ACTION_CATALOG[actionType]?.judgeable?.(content ?? {}) ?? false;
}

/** 行为的中文文案，未登记时退化为原始值 */
export function getActionLabel(actionType: string): string {
  return ACTION_CATALOG[actionType]?.label ?? actionType;
}

/** 单条事件 → 决策上下文的一行；不相关的返回 null */
export function renderActionLine(
  actionType: string,
  content: EventContent,
  visibility: string,
  options?: { fullSpeech: boolean },
): string | null {
  if (
    options?.fullSpeech &&
    actionType === ACTION_TYPES.SPEECH &&
    typeof content?.speech === 'string' &&
    content.speech.trim()
  ) {
    return `${content.seatNo}号位${visibility === VISIBILITY_TYPES.WOLF ? '狼队商议' : '发言'}：${content.speech.trim()}`;
  }
  return ACTION_CATALOG[actionType]?.render?.(content ?? {}, visibility) ?? null;
}
