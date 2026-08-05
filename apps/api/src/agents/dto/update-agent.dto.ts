import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// PATCH 不允许改的字段及原因：
// - name：Agent 稳定身份，历史 Player 靠它识别；换名新建 Agent 并停用旧的
// - memoryLabel：换记忆等于换人设，属运维操作不是产品能力；日常切换走 prisma studio 或 tsx 脚本，不通过 REST 暴露
export const UpdateAgentSchema = z
  .object({
    defaultModelName: z
      .string({ error: 'defaultModelName 必须是字符串' })
      .min(1, 'defaultModelName 不能为空')
      .max(64, 'defaultModelName 最长 64 字符')
      .optional(),
    notes: z.string().max(2000, 'notes 最长 2000 字符').optional(),
    isActive: z.boolean({ error: 'isActive 必须是布尔' }).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少需要更新一个字段' });

export class UpdateAgentDto extends createZodDto(UpdateAgentSchema) {}
