import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const BatchRunSchema = z.object({
  count: z.coerce.number().int().min(1).max(20),
  rulesetId: z.string().min(1),
  agentIds: z.array(z.string().uuid()).optional(), // 显式 Agent 池；缺省用所有 isActive
  shuffleAgents: z.boolean().optional().default(true),
});

export class BatchRunDto extends createZodDto(BatchRunSchema) {}
