import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateAgentSchema = z.object({
  name: z
    .string({ error: 'name 必须是字符串' })
    .min(1, 'name 不能为空')
    .max(64, 'name 最长 64 字符'),
  defaultModelName: z
    .string({ error: 'defaultModelName 必须是字符串' })
    .min(1, 'defaultModelName 不能为空')
    .max(64, 'defaultModelName 最长 64 字符'),
  memoryLabel: z
    .string({ error: 'memoryLabel 必须是字符串' })
    .min(1, 'memoryLabel 不能为空')
    .max(128, 'memoryLabel 最长 128 字符'),
  notes: z.string().max(2000, 'notes 最长 2000 字符').optional(),
});

export class CreateAgentDto extends createZodDto(CreateAgentSchema) {}
