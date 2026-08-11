import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const AntidoteInputSchema = z.object({
  targetSeatNo: z.number().int().min(1).describe('要救活的目标玩家座位号'),
});

const PoisonInputSchema = z.object({
  targetSeatNo: z.number().int().min(1).describe('要毒杀的目标玩家座位号'),
});

const AntidoteOutputSchema = z.object({
  action: z.literal('antidote'),
  actorId: z.string().uuid(),
  targetSeatNo: z.number().int().min(1),
});

const PoisonOutputSchema = z.object({
  action: z.literal('poison'),
  actorId: z.string().uuid(),
  targetSeatNo: z.number().int().min(1),
});

export type UseAntidoteOutput = z.infer<typeof AntidoteOutputSchema>;
export type UsePoisonOutput = z.infer<typeof PoisonOutputSchema>;

export const createUseAntidoteTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<UseAntidoteOutput> => {
      return {
        action: 'antidote',
        actorId: ctx.currentPlayerId,
        targetSeatNo: input.targetSeatNo,
      };
    },
    {
      name: 'use_antidote',
      description: `
        使用解药救活目标玩家。系统已告知你被刀玩家的座位号，你需要明确指定要救的座位号。
      `.trim(),
      schema: AntidoteInputSchema,
    },
  );

export const createUsePoisonTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<UsePoisonOutput> => {
      return {
        action: 'poison',
        actorId: ctx.currentPlayerId,
        targetSeatNo: input.targetSeatNo,
      };
    },
    {
      name: 'use_poison',
      description: `
        使用毒药毒杀目标玩家。毒药只能使用一次，请谨慎选择目标。
      `.trim(),
      schema: PoisonInputSchema,
    },
  );
