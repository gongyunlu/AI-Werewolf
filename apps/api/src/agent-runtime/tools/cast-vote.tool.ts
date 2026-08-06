import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({
  targetSeatNo: z
    .number()
    .int()
    .min(1)
    .describe('要投票放逐的目标玩家座位号,必须是当前存活玩家的座位号'),
});

const OutputSchema = z.object({
  voterPlayerId: z.string().uuid(),
  voterSeatNo: z.number().int().min(1),
  targetPlayerId: z.string().uuid(),
  targetSeatNo: z.number().int().min(1),
});

export type CastVoteOutput = z.infer<typeof OutputSchema>;

/**
 * 发起投票放逐
 * @param prisma
 * @param ctx
 * @returns
 */
export const createCastVoteTool = (prisma: PrismaService, ctx: ToolContext) =>
  tool(
    async (input): Promise<CastVoteOutput> => {
      const voter = await prisma.player.findUnique({
        where: { id: ctx.currentPlayerId },
        select: { id: true, seatNo: true, gameId: true, deathDay: true },
      });
      if (!voter || voter.gameId !== ctx.gameId) {
        throw new Error('玩家不存在');
      }

      if (voter.deathDay !== null) {
        throw new Error('你已出局，无法投票');
      }

      const target = await prisma.player.findUnique({
        where: { gameId_seatNo: { gameId: ctx.gameId, seatNo: input.targetSeatNo } },
        select: { id: true, seatNo: true, deathDay: true },
      });
      if (!target) {
        throw new Error(`本局不存在座次 ${input.targetSeatNo}`);
      }
      if (target.deathDay !== null) {
        throw new Error(`目标 ${input.targetSeatNo} 号已出局,不能投票给已出局玩家`);
      }

      // TODO: 在引擎结算逻辑接入后补全落库操作(需要 sequence/day/phase 上下文写 Event 表)

      return {
        voterPlayerId: voter.id,
        voterSeatNo: voter.seatNo,
        targetPlayerId: target.id,
        targetSeatNo: target.seatNo,
      };
    },
    {
      name: 'cast_vote',
      description:
        '对目标玩家投出放逐票。这是最终动作,一旦调用即视为本轮投票已确定。目标必须是存活玩家的座位号(先用 get_alive_players 确认)。',
      schema: InputSchema,
    },
  );
