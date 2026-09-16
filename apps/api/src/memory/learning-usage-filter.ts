import { Prisma } from '../generated/prisma/client';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';

// 对齐奖励回填：旧 usage 只有在同键真实事件唯一时才能关联，不能只数已评分事件。
const usageEventId = Prisma.sql`COALESCE(u.event_id, (
  SELECT (array_agg(legacy_event.id))[1]
  FROM events legacy_event
  WHERE legacy_event.game_id = u.game_id AND legacy_event.actor_id = u.player_id
    AND legacy_event.action_type = u.action_type AND legacy_event.day = u.day
  HAVING count(*) = 1
))`;

/** u 为 usage：只使用普通局中仍与当前版本评分一致的 reward，保留历史行。 */
export const CURRENT_LEARNING_REWARD_FILTER = Prisma.sql`
  AND u.reward_score IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM games g WHERE g.id = u.game_id
      AND (g.experiment IS NULL OR g.experiment = 'null'::jsonb)
  )
  AND (
    EXISTS (
      SELECT 1 FROM decision_judgments j
      WHERE j.event_id = ${usageEventId} AND j.game_id = u.game_id
        AND j.evaluation_version = ${EVALUATION_VERSION} AND j.score = u.reward_score
    )
    OR EXISTS (
      SELECT 1 FROM team_judgments t JOIN events e ON e.id = t.event_id
      WHERE t.game_id = u.game_id AND t.evaluation_version = ${EVALUATION_VERSION}
        AND t.score = u.reward_score
        AND (t.event_id = ${usageEventId} OR e.content->'proposalEventIds' @> jsonb_build_array(${usageEventId}::text))
    )
  )
`;

export const CURRENT_LEARNING_USAGE_FILTER = Prisma.sql`
  AND u.trigger_matched = true
  ${CURRENT_LEARNING_REWARD_FILTER}
`;
