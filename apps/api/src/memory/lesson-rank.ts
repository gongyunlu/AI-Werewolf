/** 一条 lesson 命中样本：某次注入该 lesson 且 trigger 匹配的行为及其 reward */
export interface LessonHit {
  actionType: string;
  reward: number;
}

export interface LessonRankInput {
  /** 命中样本（triggerMatched=true 且 rewardScore 非空） */
  hits: LessonHit[];
  /** 各 actionType 的全局基线分（decision_judgments 平均） */
  baselineByActionType: ReadonlyMap<string, number>;
  /** 未登记 actionType 的兜底基线（各 actionType 基线的算术平均） */
  defaultBaseline: number;
  /** 该 agent 全部 lesson 的命中总数，UCB 探索项的 N */
  totalHits: number;
  /** 冷启动先验（0~1），无命中样本时作为 rank */
  importance: number;
  /** 贝叶斯收缩常数 */
  k?: number;
  /** UCB 探索系数 */
  c?: number;
}

/**
 * 计算一条 lesson 的质量分 rank。
 *
 * lift = 命中样本相对同 actionType 基线的平均提升；quality = lift × n/(n+k) 做贝叶斯收缩，
 * 防小样本极端值；再加 UCB 探索项，让命中少（未被充分验证）的经验有机会被注入积累样本。
 * 无命中样本时退回 importance 先验（×100 拉到 0~100 分数量纲，与 lift 对齐）。
 * k、c 为初值，待跑出更多命中样本后校准。
 */
export function computeLessonRank(input: LessonRankInput): number {
  const { hits, baselineByActionType, defaultBaseline, totalHits, importance } = input;
  const k = input.k ?? 5;
  const c = input.c ?? 10;

  const n = hits.length;
  if (n === 0) {
    return importance * 100;
  }

  const lift =
    hits.reduce((sum, h) => {
      const baseline = baselineByActionType.get(h.actionType) ?? defaultBaseline;
      return sum + (h.reward - baseline);
    }, 0) / n;

  const quality = lift * (n / (n + k));
  const exploration = c * Math.sqrt(Math.log(Math.max(totalHits, 1)) / n);
  return quality + exploration;
}

/**
 * 把语义相似度与质量分组合成候选分数。
 *
 * rank 允许为负；若直接 similarity × rank，负数区间会反转相关性（越相似反而越靠后）。
 * lift 的理论下界大于 -100，这里仍防御性夹到最小正权重，并排除非正相似度。
 */
export function computeLessonCandidateScore(similarity: number, rank: number): number {
  if (!Number.isFinite(similarity) || similarity <= 0) return Number.NEGATIVE_INFINITY;
  const qualityWeight = Math.max(1, 100 + rank);
  return similarity * qualityWeight;
}
