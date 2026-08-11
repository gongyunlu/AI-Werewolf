import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({
  targetSeatNo: z.number().int().min(1).describe('要查验的目标玩家座位号'),
});

const OutputSchema = z.object({
  action: z.literal('check_identity'),
  actorId: z.string(),
  targetSeatNo: z.number().int().min(1),
});

export type CheckIdentityOutput = z.infer<typeof OutputSchema>;

export const createCheckIdentityTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<CheckIdentityOutput> => {
      return {
        action: 'check_identity',
        actorId: ctx.currentPlayerId,
        targetSeatNo: input.targetSeatNo,
      };
    },
    {
      name: 'check_identity',
      description: `
        预言家专属技能：查验目标玩家的身份（好人/狼人）。

        规则：
        - 每晚只能查验一名玩家
        - 不能查验自己
        - 不能查验已经查验过的玩家（查看"你的查验历史"）
        - 不能查验已死亡的玩家

        返回结果：好人 或 狼人
      `.trim(),
      schema: InputSchema,
    },
  );
