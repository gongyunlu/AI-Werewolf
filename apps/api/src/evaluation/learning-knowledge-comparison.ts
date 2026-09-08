import type { PrismaClient } from '../generated/prisma/client';
import { EVALUATION_VERSION } from './evaluation-version';

/** 注入按 usage 存在判定，分数读取当前 judgment，不受 reward 回填进度影响。 */
export function loadKnowledgeScoredEvents(prisma: Pick<PrismaClient, '$queryRaw'>) {
  return prisma.$queryRaw<Array<{ eventId: string; score: number; injected: boolean }>>`
    SELECT dj.event_id AS "eventId", dj.score,
      EXISTS (
        SELECT 1 FROM knowledge_usages u
        WHERE u.game_id = dj.game_id AND u.event_id = dj.event_id
      ) AS injected
    FROM decision_judgments dj JOIN games g ON g.id = dj.game_id
    WHERE dj.evaluation_version = ${EVALUATION_VERSION}
      AND (g.experiment IS NULL OR g.experiment = 'null'::jsonb)
  `;
}
