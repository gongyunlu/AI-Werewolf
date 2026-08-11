import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

/**
 * 投票工具上下文（扩展）
 */
export interface CastVoteToolContext extends ToolContext {
  allowAbstain?: boolean; // 是否允许弃票（默认 true）
  validTargets?: number[]; // 有效目标座位号列表（PK投票时使用）
}

const InputSchema = z.object({
  targetSeatNo: z.number().int().min(0).describe('要投票的目标玩家座位号（0表示弃票）'),
});

const OutputSchema = z.object({
  action: z.literal('cast_vote'),
  actorId: z.string(),
  targetSeatNo: z.number().int().min(0),
});

export type CastVoteOutput = z.infer<typeof OutputSchema>;

/**
 * 投票工具
 */
export const createCastVoteTool = (ctx: CastVoteToolContext) => {
  const { allowAbstain = true, validTargets } = ctx;

  let description = '白天投票：投票放逐目标玩家。得票最多的玩家将被放逐出局。';

  if (!allowAbstain) {
    description += ' 注意：这是平票 PK 阶段投票，不允许弃票。';
  } else {
    description += ' 你可以选择弃票（targetSeatNo=0）。';
  }

  if (validTargets && validTargets.length > 0) {
    description += ` 你只能投给以下座位号: ${validTargets.join(', ')}。`;
  }

  return tool(
    async (input): Promise<CastVoteOutput> => {
      // 平票 PK 阶段投票不允许弃票
      if (!allowAbstain && input.targetSeatNo === 0) {
        throw new Error('PK投票不允许弃票，请选择一个有效目标');
      }

      // 平票 PK 阶段投票只能投有效目标
      if (validTargets && validTargets.length > 0 && input.targetSeatNo !== 0) {
        if (!validTargets.includes(input.targetSeatNo)) {
          throw new Error(`无效的投票目标，只能投给: ${validTargets.join(', ')}`);
        }
      }

      return {
        action: 'cast_vote',
        actorId: ctx.currentPlayerId,
        targetSeatNo: input.targetSeatNo,
      };
    },
    {
      name: 'cast_vote',
      description,
      schema: InputSchema,
    },
  );
};
