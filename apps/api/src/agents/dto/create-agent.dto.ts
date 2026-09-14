import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateAgentSchema = z
  .object({
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
    // 自带接入：两者必须成对出现，只填其一会把密钥打到不相干的端点上
    baseUrl: z
      .url({ error: 'baseUrl 必须是合法 URL' })
      .max(512, 'baseUrl 最长 512 字符')
      .optional(),
    apiKey: z
      .string({ error: 'apiKey 必须是字符串' })
      .min(1, 'apiKey 不能为空')
      .max(512, 'apiKey 最长 512 字符')
      .optional(),
    tag: z.string().max(64, 'tag 最长 64 字符').optional(),
    notes: z.string().max(2000, 'notes 最长 2000 字符').optional(),
  })
  .refine((v) => Boolean(v.baseUrl) === Boolean(v.apiKey), {
    message: 'baseUrl 与 apiKey 必须同时提供；都不填则回落到环境变量里的默认接入',
    path: ['baseUrl'],
  });

export class CreateAgentDto extends createZodDto(CreateAgentSchema) {}
