import { ModelCallError } from '@/llm/model-call-guard';
import { failAfterEffect, failModelCall } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import { ROLES, ACTION_TYPES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { saveNodeValue } from '../node.types';
import { checkSeerResult } from '../../rules/seer-check';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 构建预言家查验决策 Schema（值域动态收敛到合法候选）
 */
export function buildSeerCheckSchema(legalSeatNos: number[]) {
  return z.object({
    action: z.enum(['check_identity']),
    targetSeatNo: z
      .number()
      .int()
      .describe(`要查验的座位号（只能从合法候选中选择：${legalSeatNos.join('、')}号）`),
  });
}

type SeerCheckDecision = {
  action: 'check_identity';
  targetSeatNo: number;
};

/**
 * 预言家查验节点（理由与动作一并生成）
 */
@Injectable()
export class SeerCheckNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  /**
   * 创建节点工厂函数
   */
  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const seer = state.players.find((p) => p.isAlive && p.role === ROLES.SEER);

      if (!seer) {
        return {};
      }

      const nightPromptEvent = await context.eventWriter.writeNightPromptEvent({
        phaseInstanceId: state.phaseInstanceId,
        signal: context.signal,
        gameId: state.gameId,
        day: state.currentDay,
        content: '预言家，请睁眼。',
        targetRole: 'SEER',
      });
      await context.eventBus?.publish(nightPromptEvent);

      // 查询本局预言家已查验过的座位号（用于硬校验「未查验过」）
      const checkedEvents = await saveNodeValue(context, 'previous-checks', () =>
        context.prisma.event.findMany({
          where: { gameId: state.gameId, actionType: ACTION_TYPES.SEER_CHECK, actorId: seer.id },
          select: { content: true },
        }),
      );
      const checkedSeatNos = new Set(
        checkedEvents
          .map((e) => (e.content as { targetSeatNo?: number } | null)?.targetSeatNo)
          .filter((n): n is number => typeof n === 'number'),
      );

      // 计算合法查验候选：存活 + 非自己 + 未查验过
      const legalSeatNos = state.players
        .filter((p) => p.isAlive && p.id !== seer.id && !checkedSeatNos.has(p.seatNo))
        .map((p) => p.seatNo);

      if (legalSeatNos.length === 0) {
        return {};
      }

      let effectStarted = false;
      try {
        // 准备上下文（Node 层收集数据 + 注入合法候选）
        const legalHint = `你今晚只能查验以下存活且未查验过的玩家：${legalSeatNos.join('号、')}号。`;
        const contextData = await this.prepareContext(state, seer.id, context, legalHint);

        const { reasoning, decision } = await this.agentRuntime.decide<SeerCheckDecision>(
          contextData,
          buildSeerCheckSchema(legalSeatNos),
          context.signal,
        );

        const targetPlayer = state.players.find((p) => p.seatNo === decision.targetSeatNo);

        // 硬校验：目标必须存活、非自己、未查验过
        if (
          !targetPlayer ||
          !targetPlayer.isAlive ||
          targetPlayer.seatNo === seer.seatNo ||
          checkedSeatNos.has(decision.targetSeatNo)
        ) {
          throw new ModelCallError('invalid_output');
        }

        const checkResult = checkSeerResult(targetPlayer);

        effectStarted = true;
        const seerCheckEvent = await context.eventWriter.writeSeerCheckEvent({
          source: contextData.source,
          phaseInstanceId: state.phaseInstanceId,
          signal: context.signal,
          gameId: state.gameId,
          day: state.currentDay,
          actorId: seer.id,
          targetSeatNo: targetPlayer.seatNo,
          result: checkResult,
          thinking: reasoning,
        });
        await this.agentRuntime.recordExperienceUsages(contextData, seerCheckEvent);
        await context.eventBus?.publish(seerCheckEvent);

        return {
          seerCheckTarget: decision.targetSeatNo,
          seerCheckResult: { targetSeatNo: decision.targetSeatNo, result: checkResult },
        };
      } catch (error) {
        if (effectStarted) failAfterEffect(error);
        failModelCall(error, context, '[预言家查验] 执行异常');
      }
    };
  }

  /**
   * 准备上下文（Node 层负责数据收集）
   */
  private async prepareContext(
    state: GameGraphState,
    playerId: string,
    _context: any,
    additionalContext?: string,
  ) {
    // 复用 AgentRuntimeService 的 prepareContextPublic
    return this.agentRuntime.prepareContextPublic({
      phaseInstanceId: state.phaseInstanceId,
      gameId: state.gameId,
      playerId: playerId,
      scenario: 'night_action',
      actionType: 'seer_check',
      position: {
        day: state.currentDay,
        phase: '预言家查验',
        round: 0,
        aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
      },
      additionalContext: additionalContext,
    });
  }
}
