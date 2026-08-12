import type { GameGraphState } from '../../core/types';
import type { GameNode } from '../node.types';
import { checkWinCondition } from '../../rules/win-condition';

/**
 * 胜负判定节点
 */
export const checkWinNode: GameNode = async (state: GameGraphState) => {
  const result = checkWinCondition(state.players, state.loverPair);

  return {
    isGameOver: result.isGameOver,
    winner: result.winner,
    currentPhase: 'check_win',
  };
};
