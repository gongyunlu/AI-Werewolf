import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AnalyzeGameSchema = z.object({
  /** 是否重跑决策与发言评分 */
  judge: z.boolean().optional().default(true),
  /** 是否重跑复盘与反思 */
  reflect: z.boolean().optional().default(true),
  /** 只反思指定玩家 */
  playerId: z.uuid().optional(),
  /** 绕过幂等强制重跑：反思重跑会先软删除本局旧记忆，避免新旧经验并存 */
  force: z.boolean().optional().default(false),
});

export class AnalyzeGameDto extends createZodDto(AnalyzeGameSchema) {}
