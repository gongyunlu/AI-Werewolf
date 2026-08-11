import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({
  reason: z.string().max(200).optional().describe('空过的理由（可选）'),
});

const OutputSchema = z.object({
  action: z.literal('skip'),
  actorId: z.string(),
  reason: z.string().optional(),
});

export type SkipActionOutput = z.infer<typeof OutputSchema>;

/**
 * 空过工具
 * @param ctx - 工具上下文
 * @returns 空过工具实例
 */
export const createSkipActionTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<SkipActionOutput> => {
      return {
        action: 'skip',
        actorId: ctx.currentPlayerId,
        reason: input.reason,
      };
    },
    {
      name: 'skip_action',
      description:
        '空过：本阶段不执行任何行动。例如女巫选择不用药、或者你认为当前不需要执行任何操作。',
      schema: InputSchema,
    },
  );
