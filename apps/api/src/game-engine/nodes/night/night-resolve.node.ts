import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { ROLES } from '@ai-werewolf/shared';
import { resolveNightActions } from '../../rules/night-resolution';

/**
 * 夜间结算节点
 *
 * 职责：调用 rules/night-resolution 的统一结算逻辑，
 * 处理狼刀、守卫守护、女巫解药/毒药的同守同救与死因优先级。
 */
export const createNightResolveNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const witch = state.players.find((p) => p.role === ROLES.WITCH);

    // 统一结算：守卫守护抵消刀人、解药救人、毒药生效、同守同救
    const result = resolveNightActions({
      players: state.players,
      wolfTarget: state.wolfTarget,
      guardTarget: state.guardTarget,
      witchAntidoteTarget: state.witchAntidoteTarget,
      witchPoisonTarget: state.witchPoisonTarget,
      witchPlayerId: witch?.id,
      currentDay: state.currentDay,
    });

    const nightDeaths = result.deaths;

    // 更新玩家死亡状态（死因取自结算结果，而非硬编码 night_kill）
    const updatedPlayers = state.players.map((p) => {
      const deathRecord = nightDeaths.find((d) => d.playerId === p.id);
      if (deathRecord && p.isAlive) {
        return {
          ...p,
          isAlive: false,
          deathDay: state.currentDay,
          deathCause: deathRecord.cause,
        };
      }
      return p;
    });

    // 更新数据库中的玩家死亡状态
    const deadPlayers = updatedPlayers.filter((p) => !p.isAlive && p.deathDay === state.currentDay);

    for (const player of deadPlayers) {
      await context.prisma.player.update({
        where: { id: player.id },
        data: {
          deathDay: player.deathDay,
          deathCause: player.deathCause,
        },
      });
    }

    return {
      players: updatedPlayers,
      nightDeaths,
    };
  };
};
