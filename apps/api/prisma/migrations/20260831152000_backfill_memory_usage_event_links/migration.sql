-- 历史 memory_usages 没有 event_id。只有同一局、玩家、行为、天恰好只有一条真实 Event，
-- 且该 Event 恰好有评分时，才能无歧义地恢复关联。
-- 不能只数 decision_judgments：例如同日普通票弃权、PK 票有效时只有一条评分，
-- 但有两次真实行为；按「唯一评分」会把两次 usage 都错绑到有效票。
--
-- 对唯一 Event 而言，同一 memory 重复出现只可能是 prepareContext/节点重试留下的重复观测。
-- 先保留最早一行；若已有 exact row，则旧 NULL row 全部删除，避免 UPDATE 撞唯一约束。
WITH unique_events AS (
  SELECT game_id,
         actor_id AS player_id,
         action_type,
         day,
         min(id::text)::uuid AS event_id
  FROM events
  WHERE actor_id IS NOT NULL
    AND day IS NOT NULL
  GROUP BY game_id, actor_id, action_type, day
  HAVING count(*) = 1
), safe_links AS (
  SELECT u.id,
         u.memory_id,
         e.event_id,
         EXISTS (
           SELECT 1
           FROM memory_usages exact
           WHERE exact.memory_id = u.memory_id
             AND exact.event_id = e.event_id
         ) AS already_linked,
         row_number() OVER (
           PARTITION BY u.memory_id, e.event_id
           ORDER BY u.created_at, u.id
         ) AS rn
  FROM memory_usages u
  JOIN unique_events e
    ON e.game_id = u.game_id
   AND e.player_id = u.player_id
   AND e.action_type = u.action_type
   AND e.day = u.day
  JOIN decision_judgments j
    ON j.event_id = e.event_id
  WHERE u.event_id IS NULL
)
DELETE FROM memory_usages u
USING safe_links s
WHERE u.id = s.id
  AND (s.already_linked OR s.rn > 1);

WITH unique_events AS (
  SELECT game_id,
         actor_id AS player_id,
         action_type,
         day,
         min(id::text)::uuid AS event_id
  FROM events
  WHERE actor_id IS NOT NULL
    AND day IS NOT NULL
  GROUP BY game_id, actor_id, action_type, day
  HAVING count(*) = 1
)
UPDATE memory_usages u
SET event_id = e.event_id
FROM unique_events e
JOIN decision_judgments j ON j.event_id = e.event_id
WHERE u.event_id IS NULL
  AND e.game_id = u.game_id
  AND e.player_id = u.player_id
  AND e.action_type = u.action_type
  AND e.day = u.day;

-- 精确链接建立后立即刷新 reward，避免继续沿用迁移前的粗键结果。
UPDATE memory_usages u
SET reward_score = j.score
FROM decision_judgments j
WHERE u.event_id = j.event_id
  AND u.reward_score IS DISTINCT FROM j.score;
