import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({});

// Agent 只应看到公开信息：座位号 + displayName
// 身份/阵营/角色一律不返回
// 狼队视角额外可见的信息由高层进行 prompt 注入
const AlivePlayerSchema = z.object({
  seatNo: z.number().int().min(1),
  displayName: z.string(),
  isSelf: z.boolean(),
});

const OutputSchema = z.object({
  alive: z.array(AlivePlayerSchema),
});

export type GetAlivePlayersOutput = z.infer<typeof OutputSchema>;

/**
 * 获取当前对局存活玩家列表
 * @param prisma
 * @param ctx
 * @returns
 */
export const createGetAlivePlayersTool = (prisma: PrismaService, ctx: ToolContext) =>
  tool(
    async (): Promise<GetAlivePlayersOutput> => {
      // deathDay 为 null 视为存活；不用另加 isAlive
      const players = await prisma.player.findMany({
        where: { gameId: ctx.gameId, deathDay: null },
        orderBy: { seatNo: 'asc' },
        select: { id: true, seatNo: true, displayName: true },
      });

      return {
        alive: players.map((p) => ({
          seatNo: p.seatNo,
          displayName: p.displayName,
          isSelf: p.id === ctx.currentPlayerId,
        })),
      };
    },
    {
      name: 'get_alive_players',
      description:
        '获取当前对局所有存活玩家的座位号和 displayName 。用于确定谁还在场、可作为投票或技能目标。返回的 isSelf = true 标记是否是自己。',
      schema: InputSchema,
    },
  );
