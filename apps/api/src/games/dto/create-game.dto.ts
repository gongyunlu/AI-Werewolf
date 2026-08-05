import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// 创建对局：传入 Agent id 列表，并从 Agent 拷贝 defaultModelName/name 到 Player
export const CreateGameSchema = z.object({
  rulesetId: z.string({ error: 'rulesetId 必须是字符串' }).min(1, 'rulesetId 不能为空'),
  agentIds: z
    .array(z.string({ error: 'agentId 必须是字符串' }).uuid('agentId 必须是 uuid 格式'), {
      error: 'agentIds 必须是数组',
    })
    .min(1, 'agentIds 至少包含一个 Agent'),
});

export class CreateGameDto extends createZodDto(CreateGameSchema) {}
