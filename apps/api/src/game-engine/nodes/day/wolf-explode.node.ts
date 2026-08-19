import { Injectable } from '@nestjs/common';
import { ROLES, DEATH_CAUSES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 狼人自爆决策 Schema
 */
const WolfExplodeDecisionSchema = z.object({
  action: z.enum(['explode', 'hold']),
  reason: z.string().optional().describe('决策理由（可选）'),
});

type WolfExplodeDecision =
  { action: 'explode'; reason?: string } | { action: 'hold'; reason?: string };

/**
 * 狼人自爆节点（天亮公布死讯后）
 *
 * 天亮公布死讯后，逐个询问存活狼人是否自爆。
 * 任一狼人选择自爆即：公开身份、立即出局、当天直接进入黑夜（跳过发言与投票）。
 * 通过 state.interrupt 标记，由 GameEngine 检测后中断白天管道。
 */
@Injectable()
export class WolfExplodeNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const werewolves = state.players.filter((p) => p.isAlive && p.role === ROLES.WEREWOLF);

      if (werewolves.length === 0) {
        return {};
      }

      // 并发询问所有存活狼人是否自爆：任一狼最先自爆即中止其余询问（竞争关系）
      const raceController = new AbortController();
      const onGameAbort = () => raceController.abort();
      context.signal?.addEventListener('abort', onGameAbort);
      if (context.signal?.aborted) raceController.abort();

      let explodeWinner: (typeof werewolves)[number] | null = null;
      let explodeReason: string | undefined;

      const decide = async (wolf: (typeof werewolves)[number]): Promise<void> => {
        if (raceController.signal.aborted) return;

        try {
          const contextData = await this.agentRuntime.prepareContextPublic(
            state.gameId,
            wolf.id,
            'night_action' as any,
            '现在是天亮阶段。你可以选择自爆：公开你的狼人身份，立即结束白天进入黑夜，跳过发言与投票。',
          );

          const threadId = getPlayerThreadId(state.gameId, wolf.id);

          const reasoning = await this.agentRuntime.streamReasoning(
            contextData,
            threadId,
            raceController.signal,
          );

          const decision = await this.agentRuntime.generateDecision<WolfExplodeDecision>(
            contextData,
            reasoning,
            WolfExplodeDecisionSchema,
            raceController.signal,
            threadId,
          );

          if (decision.action === 'explode' && explodeWinner === null) {
            explodeWinner = wolf;
            explodeReason = decision.reason;
            raceController.abort(); // 中止其余狼人的询问
          }
        } catch (error) {
          // 被其余狼抢先自爆或游戏中止导致的 abort 属正常竞争结果，忽略
          if (raceController.signal.aborted) return;
          gameLogger.error(
            `[狼人自爆] ${wolf.seatNo}号位决策失败，跳过: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      await Promise.allSettled(werewolves.map(decide));
      context.signal?.removeEventListener('abort', onGameAbort);

      if (!explodeWinner) {
        return {};
      }

      const wolf = explodeWinner as (typeof werewolves)[number];
      gameLogger.log(
        `[狼人自爆] ${wolf.seatNo}号位狼人自爆${explodeReason ? `：${explodeReason}` : ''}`,
      );

      // 法官播报自爆（公开）
      const event = await context.eventWriter.writeJudgeEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: `${wolf.seatNo}号位狼人自爆，进入黑夜。`,
      });
      await context.eventBus?.publish(event);

      // 标记自爆狼人死亡
      const updatedPlayers = state.players.map((p) =>
        p.id === wolf.id
          ? {
              ...p,
              isAlive: false,
              deathDay: state.currentDay,
              deathCause: DEATH_CAUSES.SELF_DESTRUCT,
            }
          : p,
      );

      // 持久化死亡状态
      await context.prisma.player.update({
        where: { id: wolf.id },
        data: {
          deathDay: state.currentDay,
          deathCause: DEATH_CAUSES.SELF_DESTRUCT,
        },
      });

      return {
        players: updatedPlayers,
        interrupt: { type: 'wolf_explode', triggeredBy: wolf.id },
      };
    };
  }
}
