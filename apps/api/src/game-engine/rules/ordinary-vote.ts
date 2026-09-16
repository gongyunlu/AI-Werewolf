export type VoteAction = { action: 'cast_vote'; targetSeatNo: number } | { action: 'abstain' };

/** 普通投票可投任一存活座位（含本人），也可明确弃票。 */
export function legalVoteActions(aliveSeatNos: number[]): VoteAction[] {
  return [
    ...aliveSeatNos.map((targetSeatNo) => ({ action: 'cast_vote' as const, targetSeatNo })),
    { action: 'abstain' },
  ];
}

export function isLegalVoteAction(value: VoteAction, legalSeatNos: number[]): boolean {
  return legalVoteActions(legalSeatNos).some(
    (action) =>
      action.action === value.action &&
      (action.action === 'abstain' ||
        (value.action === 'cast_vote' && action.targetSeatNo === value.targetSeatNo)),
  );
}
