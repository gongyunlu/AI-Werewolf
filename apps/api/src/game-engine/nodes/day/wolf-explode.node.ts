import { Injectable } from '@nestjs/common';
import { ROLES, DEATH_CAUSES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { throwIfAborted } from '@/llm/abort.utils';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import { allowModelFallback, failAfterEffect } from '../../core/game-failure-policy';

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

      const recorded =
        (await context.recovery?.recordedEffects<{
          actorId: string;
          content: { action: string; reason?: string };
        }>('event/wolf_explode/')) ?? [];
      const committedWinner = recorded.find((event) => event.content.action === 'explode');

      // 并发询问所有存活狼人是否自爆：任一狼最先自爆即中止其余询问（竞争关系）
      const raceController = new AbortController();
      const onGameAbort = () => raceController.abort();
      context.signal?.addEventListener('abort', onGameAbort);
      if (context.signal?.aborted) raceController.abort();

      let explodeWinner: (typeof werewolves)[number] | null =
        werewolves.find((wolf) => wolf.id === committedWinner?.actorId) ?? null;
      let explodeReason: string | undefined = committedWinner?.content.reason;

      const decide = async (wolf: (typeof werewolves)[number]): Promise<void> => {
        if (raceController.signal.aborted) return;
        let effectStarted = false;
        try {
          const contextData = await this.agentRuntime.prepareContextPublic({
            gameId: state.gameId,
            playerId: wolf.id,
            scenario: 'night_action',
            actionType: 'wolf_explode',
            position: {
              aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
              day: state.currentDay,
              phase: '天亮自爆询问（公开发言之前）',
              round: 0,
            },
            additionalContext:
              '现在是天亮阶段。你可以选择自爆：公开你的狼人身份并立即出局（自己死亡退场），当天白天直接结束进入黑夜，跳过发言与投票。自爆是牺牲自己换取跳过白天，请审慎判断是否值得。',
          });

          const { reasoning, decision } = await this.agentRuntime.decide<WolfExplodeDecision>(
            contextData,
            WolfExplodeDecisionSchema,
            raceController.signal,
          );

          throwIfAborted(raceController.signal);
          if (!committedWinner && decision.action === 'explode' && explodeWinner === null) {
            explodeWinner = wolf;
            explodeReason = decision.reason;
            raceController.abort(); // 中止其余狼人的询问
          }
          effectStarted = true;
          const decisionEvent = await context.eventWriter.writeWolfDecisionEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: wolf.id,
            actionType: 'wolf_explode',
            content: {
              action: decision.action,
              seatNo: wolf.seatNo,
              thinking: reasoning,
              reason: decision.reason,
            },
          });
          await this.agentRuntime.recordExperienceUsages(contextData, decisionEvent);
        } catch (error) {
          if (effectStarted) failAfterEffect(error);
          if (error instanceof ExperimentInvalidError) {
            raceController.abort();
            throw error;
          }
          // 被其余狼抢先自爆或游戏中止导致的 abort 属正常竞争结果，忽略
          if (raceController.signal.aborted) return;
          await allowModelFallback(error, context, wolf.id);
          gameLogger.error(
            `[狼人自爆] ${wolf.seatNo}号位决策失败，跳过: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const participants = committedWinner
        ? werewolves.filter((wolf) => recorded.some((event) => event.actorId === wolf.id))
        : werewolves;
      const results = await Promise.allSettled(participants.map(decide));
      context.signal?.removeEventListener('abort', onGameAbort);
      const invalid = results.find((result) => result.status === 'rejected');
      if (invalid?.status === 'rejected') throw invalid.reason;
      throwIfAborted(context.signal);

      if (!explodeWinner) {
        return {};
      }

      const wolf = explodeWinner as (typeof werewolves)[number];
      gameLogger.log(
        `[狼人自爆] ${wolf.seatNo}号位狼人自爆${explodeReason ? `：${explodeReason}` : ''}`,
      );

      // 法官播报自爆（公开）：播报与自爆狼出局必须同一事务，避免只落其一。
      const event = await context.eventWriter.writeJudgeEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: `${wolf.seatNo}号位狼人自爆，进入黑夜。`,
        updateState: async (tx) => {
          await tx.player.update({
            where: { id: wolf.id, gameId: state.gameId },
            data: { deathDay: state.currentDay, deathCause: DEATH_CAUSES.SELF_DESTRUCT },
          });
        },
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

      return {
        players: updatedPlayers,
        interrupt: { type: 'wolf_explode', triggeredBy: wolf.id },
      };
    };
  }
}
