export interface ScoredObservation {
  evaluationComplete?: boolean;
  gameId: string;
  agentId?: string;
  pairId?: string;
  arm: 'on' | 'off' | 'unknown';
  actionType: string;
  role: string;
  faction: string;
  model: string;
  visibility: string;
  evaluationVersion: number;
  score: number;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 同一局内的决策相关；先算每局均分，再对局等权。配对差只使用两臂都有该指标的配对。 */
export function summarizeObservations(rows: ScoredObservation[]) {
  rows = rows.filter((row) => row.evaluationComplete !== false);
  const summarizeArm = (arm: ScoredObservation['arm']) => {
    const selected = rows.filter((r) => r.arm === arm);
    const games = [...new Set(selected.map((r) => r.gameId))].map((gameId) => ({
      gameId,
      n: selected.filter((r) => r.gameId === gameId).length,
      mean: mean(selected.filter((r) => r.gameId === gameId).map((r) => r.score))!,
    }));
    return {
      n: selected.length,
      games: games.length,
      eventMean: mean(selected.map((r) => r.score)),
      gameMean: mean(games.map((g) => g.mean)),
      perGame: games,
    };
  };
  const pairs = [
    ...new Set(rows.map((r) => r.pairId).filter((id): id is string => Boolean(id))),
  ].flatMap((pairId) => {
    const values = (arm: 'on' | 'off') => {
      const selected = rows.filter((r) => r.pairId === pairId && r.arm === arm);
      if (selected.some((row) => row.evaluationComplete !== true)) return null;
      const gameIds = [...new Set(selected.map((r) => r.gameId))];
      if (gameIds.length > 1) throw new Error(`配对 ${pairId}/${arm} 对应多局，不能计算配对差`);
      return mean(selected.map((r) => r.score));
    };
    const on = values('on');
    const off = values('off');
    return on === null || off === null ? [] : [{ pairId, on, off, difference: on - off }];
  });
  const on = summarizeArm('on');
  const off = summarizeArm('off');
  return {
    on,
    off,
    unknown: summarizeArm('unknown'),
    gameMeanDifference:
      on.gameMean === null || off.gameMean === null ? null : on.gameMean - off.gameMean,
    pairedMeanDifference: mean(pairs.map((p) => p.difference)),
    pairs,
  };
}

export function stratifyObservations(rows: ScoredObservation[]) {
  const groups = new Map<string, ScoredObservation[]>();
  for (const row of rows) {
    const key = [
      row.evaluationVersion,
      row.actionType,
      row.role,
      row.faction,
      row.model,
      row.visibility,
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].map(([key, group]) => [key, summarizeObservations(group)]));
}

/** 先按 agent/模型匹配同类动作，再在每对对局内等权汇总，最后对完整配对等权。 */
export function summarizeAgentRolePairs(rows: ScoredObservation[]) {
  const strata = new Map<string, ScoredObservation[]>();
  for (const row of rows) {
    if (!row.agentId || !row.pairId || row.evaluationComplete !== true || row.arm === 'unknown')
      continue;
    const key = JSON.stringify([row.evaluationVersion, row.role, row.actionType, row.visibility]);
    const group = strata.get(key) ?? [];
    group.push(row);
    strata.set(key, group);
  }

  return [...strata.values()].map((group) => {
    const { evaluationVersion, role, actionType, visibility } = group[0];
    const units = new Map<string, ScoredObservation[]>();
    for (const row of group) {
      const key = JSON.stringify([row.pairId, row.agentId, row.model]);
      const unit = units.get(key) ?? [];
      unit.push(row);
      units.set(key, unit);
    }
    const comparisons = [...units.values()].map((unit) => {
      const { pairId, agentId, model } = unit[0];
      const summary = summarizeObservations(unit);
      return {
        pairId: pairId!,
        agentId: agentId!,
        model,
        on: summary.on.perGame[0] ?? null,
        off: summary.off.perGame[0] ?? null,
        difference: summary.pairedMeanDifference,
      };
    });
    const matched = comparisons.filter((unit) => unit.difference !== null);
    const perPair = [...new Set(matched.map((unit) => unit.pairId))].map((pairId) => {
      const agents = matched.filter((unit) => unit.pairId === pairId);
      return {
        pairId,
        onMean: mean(agents.map((unit) => unit.on!.mean))!,
        offMean: mean(agents.map((unit) => unit.off!.mean))!,
        difference: mean(agents.map((unit) => unit.difference!))!,
        agents,
      };
    });
    const coverage = (arm: 'on' | 'off') => {
      const selected = group.filter((row) => row.arm === arm);
      return {
        scoredEvents: selected.length,
        scoredGames: new Set(selected.map((row) => row.gameId)).size,
        matchedEvents: matched.reduce((sum, unit) => sum + unit[arm]!.n, 0),
        matchedGames: new Set(matched.map((unit) => unit[arm]!.gameId)).size,
      };
    };
    return {
      evaluationVersion,
      role,
      actionType,
      visibility,
      on: coverage('on'),
      off: coverage('off'),
      completePairs: perPair.length,
      matchedAgentPairs: matched.length,
      pairedMeanDifference: mean(perPair.map((pair) => pair.difference)),
      perPair,
      unmatched: comparisons.filter((unit) => unit.difference === null),
    };
  });
}
