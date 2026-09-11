import { TurnReviewSchema, type TurnReview } from '../player-turn/turn-reflection';

/** 模型桩返回复核意见，不代替真实模型的内容判断。 */
export function reviewed(issues: TurnReview['issues'] = []): TurnReview {
  return TurnReviewSchema.parse({
    issues,
  });
}
