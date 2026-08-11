import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({
  reason: z.string().max(200).optional().describe('跳过发言的理由（可选）'),
});

const OutputSchema = z.object({
  action: z.literal('skip_discussion'),
  actorId: z.string(),
  reason: z.string().optional(),
});

export type SkipDiscussionOutput = z.infer<typeof OutputSchema>;

/**
 * 跳过讨论工具
 *
 * 用于狼人内部讨论时，选择不发言
 */
export const createSkipDiscussionTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<SkipDiscussionOutput> => {
      return {
        action: 'skip_discussion',
        actorId: ctx.currentPlayerId,
        reason: input.reason,
      };
    },
    {
      name: 'skip_discussion',
      description:
        '跳过本轮发言。如果你觉得队友说得已经足够，或者你没有新的想法，可以选择跳过发言。',
      schema: InputSchema,
    },
  );
