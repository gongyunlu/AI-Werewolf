import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PERSONA_STRATEGY_INJECTION_LIMIT } from '../persona-strategy';

const PersonaStrategyItemSchema = z.object({
  title: z
    .string({ error: 'title 必须是字符串' })
    .trim()
    .min(1, 'title 不能为空')
    .max(256, 'title 最长 256 字符'),
  content: z
    .string({ error: 'content 必须是字符串' })
    .trim()
    .min(1, 'content 不能为空')
    .max(4000, 'content 最长 4000 字符'),
});

// 注入窗口只取 importance 前 N 条，超出部分存得下但永远进不了上下文，
// 因此直接在写入口拒绝，而不是让使用者以为保存成功了。
export class ReplacePersonaStrategyDto extends createZodDto(
  z
    .object({
      persona: z.array(PersonaStrategyItemSchema, { error: 'persona 必须是数组' }),
      strategy: z.array(PersonaStrategyItemSchema, { error: 'strategy 必须是数组' }),
    })
    .refine((v) => v.persona.length + v.strategy.length <= PERSONA_STRATEGY_INJECTION_LIMIT, {
      message: `人设与策略合计不能超过 ${PERSONA_STRATEGY_INJECTION_LIMIT} 条`,
      path: ['persona'],
    }),
) {}
