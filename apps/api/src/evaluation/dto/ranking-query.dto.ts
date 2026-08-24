import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RankingQuerySchema = z.object({
  minGames: z.coerce.number().int().min(1).optional().default(1),
  role: z.string().min(1).optional(),
});

export class RankingQueryDto extends createZodDto(RankingQuerySchema) {}
