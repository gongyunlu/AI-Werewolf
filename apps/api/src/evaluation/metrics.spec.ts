import {
  computePlayerMetrics,
  computeScore,
  computeSurvivalDays,
  computeVoteAccuracy,
  countAbilityUses,
  countSpeech,
  averageSpeechTokens,
  estimateTokens,
  selectKeyEvents,
  selectMvp,
  type MetricEvent,
  type MetricPlayer,
} from './metrics';

/** 合成玩家 */
function player(overrides: Partial<MetricPlayer> & { id: string }): MetricPlayer {
  return {
    seatNo: null,
    role: null,
    faction: null,
    deathDay: null,
    deathCause: null,
    ...overrides,
  };
}

/** 合成事件（sequence 自增） */
let seq = 0;
function event(overrides: Partial<MetricEvent>): MetricEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    sequence: seq,
    day: 1,
    actionType: 'speech',
    actorId: null,
    content: {},
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

describe('computeSurvivalDays', () => {
  it('死亡者取死亡当天', () => {
    const p = player({ id: 'p1', deathDay: 2 });
    expect(computeSurvivalDays(p, 5)).toBe(2);
  });

  it('存活者记满 totalDays', () => {
    const p = player({ id: 'p1', deathDay: null });
    expect(computeSurvivalDays(p, 5)).toBe(5);
  });
});

describe('computeVoteAccuracy', () => {
  const players = [
    player({ id: 'v1', seatNo: 1, faction: 'villager' }),
    player({ id: 'w1', seatNo: 2, faction: 'werewolf' }),
    player({ id: 'c1', seatNo: 3, faction: 'third_party' }),
  ];

  it('好人投狼算对', () => {
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager' });
    const events = [event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 2 } })];
    expect(computeVoteAccuracy(p, players, events)).toBe(1);
  });

  it('好人投好人算错', () => {
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager' });
    const events = [event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 1 } })];
    expect(computeVoteAccuracy(p, players, events)).toBe(0);
  });

  it('狼人投好人算对', () => {
    const p = player({ id: 'w1', seatNo: 2, faction: 'werewolf' });
    const events = [event({ actionType: 'vote', actorId: 'w1', content: { targetSeatNo: 1 } })];
    expect(computeVoteAccuracy(p, players, events)).toBe(1);
  });

  it('狼人投狼人算错', () => {
    const p = player({ id: 'w1', seatNo: 2, faction: 'werewolf' });
    const events = [event({ actionType: 'vote', actorId: 'w1', content: { targetSeatNo: 2 } })];
    expect(computeVoteAccuracy(p, players, events)).toBe(0);
  });

  it('弃权（targetSeatNo=0）中性不计', () => {
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager' });
    const events = [event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 0 } })];
    expect(computeVoteAccuracy(p, players, events)).toBeNull();
  });

  it('第三方投票中性不计', () => {
    const p = player({ id: 'c1', seatNo: 3, faction: 'third_party' });
    const events = [event({ actionType: 'vote', actorId: 'c1', content: { targetSeatNo: 2 } })];
    expect(computeVoteAccuracy(p, players, events)).toBeNull();
  });

  it('目标无法解析时中性跳过', () => {
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager' });
    const events = [event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 99 } })];
    expect(computeVoteAccuracy(p, players, events)).toBeNull();
  });

  it('混合投票取正确率', () => {
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager' });
    const events = [
      event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 2 } }), // 对
      event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 1 } }), // 错
    ];
    expect(computeVoteAccuracy(p, players, events)).toBe(0.5);
  });
});

describe('countAbilityUses', () => {
  it('预言家查验 +1', () => {
    const p = player({ id: 's1' });
    const events = [event({ actionType: 'seer_check', actorId: 's1' })];
    expect(countAbilityUses(p, events)).toBe(1);
  });

  it('女巫解药 saved=true 计 1，saved=false 不计', () => {
    const p = player({ id: 'w1' });
    const events = [
      event({ actionType: 'witch_save', actorId: 'w1', content: { saved: true } }),
      event({ actionType: 'witch_save', actorId: 'w1', content: { saved: false } }),
    ];
    expect(countAbilityUses(p, events)).toBe(1);
  });

  it('女巫毒药 used=true 计 1，used=false 不计', () => {
    const p = player({ id: 'w1' });
    const events = [
      event({ actionType: 'witch_poison', actorId: 'w1', content: { used: true } }),
      event({ actionType: 'witch_poison', actorId: 'w1', content: { used: false } }),
    ];
    expect(countAbilityUses(p, events)).toBe(1);
  });

  it('wolf_kill（actorId=null）不归属个人', () => {
    const p = player({ id: 'w1' });
    const events = [event({ actionType: 'wolf_kill', actorId: null })];
    expect(countAbilityUses(p, events)).toBe(0);
  });
});

describe('countSpeech / averageSpeechTokens / estimateTokens', () => {
  it('只统计本人发言', () => {
    const p = player({ id: 'p1' });
    const events = [
      event({ actionType: 'speech', actorId: 'p1' }),
      event({ actionType: 'speech', actorId: 'p2' }),
    ];
    expect(countSpeech(p, events)).toBe(1);
  });

  it('无发言时返回 null', () => {
    const p = player({ id: 'p1' });
    expect(averageSpeechTokens(p, [])).toBeNull();
  });

  it('按字符长度估算平均 token', () => {
    const p = player({ id: 'p1' });
    const events = [
      event({ actionType: 'speech', actorId: 'p1', content: { speech: 'abcd' } }), // 2 token
      event({ actionType: 'speech', actorId: 'p1', content: { speech: 'abcdef' } }), // 3 token
    ];
    expect(averageSpeechTokens(p, events)).toBe(3); // Math.round(5/2)=3
  });

  it('estimateTokens 向上取整', () => {
    expect(estimateTokens('abc')).toBe(2);
    expect(estimateTokens('abcd')).toBe(2);
  });
});

describe('computeScore', () => {
  it('胜者满存活满投票得满分', () => {
    expect(computeScore({ isWinner: true, survivalDays: 5, totalDays: 5, voteAccuracy: 1 })).toBe(
      100,
    );
  });

  it('败者零存活零投票得 0 分', () => {
    expect(computeScore({ isWinner: false, survivalDays: 0, totalDays: 5, voteAccuracy: 0 })).toBe(
      0,
    );
  });

  it('无投票时用中性基线 0.5', () => {
    const score = computeScore({
      isWinner: false,
      survivalDays: 5,
      totalDays: 5,
      voteAccuracy: null,
    });
    expect(score).toBeCloseTo(32.5, 2); // 0 + 25 + 7.5
  });
});

describe('computePlayerMetrics', () => {
  it('组合出完整指标', () => {
    const players = [
      player({ id: 'v1', seatNo: 1, faction: 'villager' }),
      player({ id: 'w1', seatNo: 2, faction: 'werewolf' }),
    ];
    const p = player({ id: 'v1', seatNo: 1, faction: 'villager', deathDay: null });
    const events = [event({ actionType: 'vote', actorId: 'v1', content: { targetSeatNo: 2 } })];

    const m = computePlayerMetrics(p, players, events, 3, 'villager');
    expect(m.survivalDays).toBe(3);
    expect(m.isWinner).toBe(true);
    expect(m.voteAccuracy).toBe(1);
    expect(m.abilityUseCount).toBe(0);
    expect(m.speechCount).toBe(0);
    expect(m.score).toBe(100);
  });
});

describe('selectKeyEvents', () => {
  it('抽取首血/放逐/终局并保持顺序', () => {
    const events = [
      event({
        actionType: 'player_died',
        content: { deaths: [{ seatNo: 3, cause: 'night_kill' }] },
      }),
      event({ actionType: 'player_executed', content: { targetSeatNo: 5 } }),
      event({ actionType: 'game_ended', content: { winner: 'werewolf' } }),
    ];

    const result = selectKeyEvents(events);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ day: 1, type: 'first_blood', seatNo: 3 });
    expect(result[1]).toEqual({ day: 1, type: 'execution', seatNo: 5 });
    expect(result[2]).toEqual({ day: 1, type: 'game_end', winner: 'werewolf' });
  });

  it('只有首个死亡事件记为首血', () => {
    const events = [
      event({ actionType: 'player_died', content: { deaths: [{ seatNo: 3 }] } }),
      event({ actionType: 'player_died', content: { deaths: [{ seatNo: 4 }] } }),
    ];
    const result = selectKeyEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].seatNo).toBe(3);
  });

  it('最多 10 条', () => {
    const events = Array.from({ length: 15 }, () =>
      event({ actionType: 'player_executed', content: { targetSeatNo: 1 } }),
    );
    expect(selectKeyEvents(events)).toHaveLength(10);
  });
});

describe('selectMvp', () => {
  it('score 最高者当选', () => {
    const mvp = selectMvp([
      { playerId: 'a', score: 50, isWinner: false, survivalDays: 1, voteAccuracy: 0 },
      { playerId: 'b', score: 90, isWinner: true, survivalDays: 3, voteAccuracy: 1 },
    ]);
    expect(mvp).toBe('b');
  });

  it('并列按 isWinner 打破平局', () => {
    const mvp = selectMvp([
      { playerId: 'a', score: 50, isWinner: false, survivalDays: 5, voteAccuracy: 1 },
      { playerId: 'b', score: 50, isWinner: true, survivalDays: 1, voteAccuracy: 0 },
    ]);
    expect(mvp).toBe('b');
  });

  it('空列表返回 null', () => {
    expect(selectMvp([])).toBeNull();
  });
});
