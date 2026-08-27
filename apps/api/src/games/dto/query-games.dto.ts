import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { GAME_STATUSES } from '@ai-werewolf/shared';

const GameStatusFilterSchema = z.preprocess(
  (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
  z
    .array(
      z.enum([
        GAME_STATUSES.CREATED,
        GAME_STATUSES.INITIALIZED,
        GAME_STATUSES.PENDING,
        GAME_STATUSES.RUNNING,
        GAME_STATUSES.PAUSED,
        GAME_STATUSES.PENDING_RECOVERY,
        GAME_STATUSES.FINISHED,
        GAME_STATUSES.ABORTED,
      ] as [string, ...string[]]),
    )
    .optional(),
);

export const QueryGamesSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: GameStatusFilterSchema,
  rulesetId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional(),
  sortBy: z.enum(['startedAt', 'endedAt']).optional().default('startedAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
});

export class QueryGamesDto extends createZodDto(QueryGamesSchema) {}
