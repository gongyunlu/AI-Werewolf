import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { GameGraphState } from '@/game-engine/core/types';
import type { NodeFactory } from '@/game-engine/nodes/node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import {
  calculateSpeechOrder,
  type SpeechOrderConfig,
} from '@/game-engine/utils/speech-order.utils';
import type { TypedRuleset } from '@/prisma/typed-models';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

const SheriffDecideOrderSchema = z.object({
  direction: z.enum(['left', 'right']).describe('发言方向：left=逆时针，right=顺时针'),
});

type SheriffDecideOrderDecision = {
  direction: 'left' | 'right';
};

/**
 * 警长决定发言顺序节点（两阶段版本）
 */
@Injectable()
export class SheriffDecideOrderNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const alivePlayers = state.players.filter((p) => p.isAlive);
      const sheriff = alivePlayers.find((p) => p.isSheriff);

      if (!sheriff) {
        return {};
      }

      const ruleset = (await context.prisma.ruleset.findUnique({
        where: { id: state.rulesetId },
      })) as TypedRuleset | null;

      if (!ruleset) {
        throw new Error(`[警长决定发言顺序] 数据一致性错误：未找到 ruleset ${state.rulesetId}`);
      }

      const config: SpeechOrderConfig = ruleset.definition.speechRules || {
        allowSheriffChooseOrder: true,
        sheriffSpeaksLast: true,
        alternateDaily: false,
      };

      if (!config.allowSheriffChooseOrder) {
        return {};
      }

      let sheriffChoice: { direction: 'left' | 'right' } | undefined;

      try {
        const contextData = await this.agentRuntime.prepareContextPublic(
          state.gameId,
          sheriff.id,
          'sheriff_decide_order' as any,
          undefined,
        );

        const threadId = getPlayerThreadId(state.gameId, sheriff.id);

        // 阶段1：流式推理
        const reasoning = await this.agentRuntime.streamReasoning(
          contextData,
          threadId,
          undefined,
          (_token) => {
            // 警长决定发言顺序不推送推理过程
          },
        );

        // 阶段2：生成决策
        const decision = await this.agentRuntime.generateDecision<SheriffDecideOrderDecision>(
          contextData,
          reasoning,
          SheriffDecideOrderSchema,
          undefined,
          threadId,
        );

        sheriffChoice = {
          direction: decision.direction,
        };

        const event = await context.eventWriter.writeSheriffDecideOrderEvent({
          gameId: state.gameId,
          day: state.currentDay,
          sheriffId: sheriff.id,
          sheriffSeatNo: sheriff.seatNo!,
          direction: decision.direction,
        });
        await context.eventBus?.publish(event);
      } catch (error) {
        gameLogger.error(
          `[警长决定发言顺序] 出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const orderResult = calculateSpeechOrder({
        state,
        config,
        currentTime: new Date(),
        sheriffChoice,
      });

      return {
        speechOrder: orderResult.speechOrder,
        speechDirection: orderResult.direction,
        speechStartSeatNo: orderResult.startSeatNo,
        speechOrderReason: orderResult.reason,
      };
    };
  }
}
