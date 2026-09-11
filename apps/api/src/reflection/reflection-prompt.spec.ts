import { ACTION_TYPES, FACTIONS, ROLES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import {
  buildGameReviewVariables,
  buildReflectionVariables,
  type ReviewEventInput,
  type ReviewPlayer,
} from './reflection-prompt';

function player(
  partial: Partial<ReviewPlayer> & { playerId: string; seatNo: number },
): ReviewPlayer {
  return {
    agentName: `agent-${partial.seatNo}`,
    role: ROLES.VILLAGER,
    faction: FACTIONS.VILLAGER,
    deathDay: null,
    isWinner: false,
    ...partial,
  };
}

function ev(partial: Partial<ReviewEventInput> & { sequence: number; actionType: string }) {
  return {
    day: 1,
    visibility: VISIBILITY_TYPES.PUBLIC,
    actorId: null,
    content: {},
    ...partial,
  } satisfies ReviewEventInput;
}

describe('buildGameReviewVariables 上帝视角复盘', () => {
  const players = [
    player({ playerId: 'p1', seatNo: 1, role: ROLES.SEER }),
    player({ playerId: 'p2', seatNo: 2, role: ROLES.WEREWOLF, faction: FACTIONS.WEREWOLF }),
  ];

  it('时间线带真实身份，且不做可见性过滤', () => {
    const events = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.SPEECH,
        actorId: 'p2',
        content: { seatNo: 2, speech: '我是预言家' },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.WOLF,
        actorId: 'p2',
        content: { seatNo: 2, speech: '今晚刀1号' },
      }),
      ev({
        sequence: 30,
        actionType: ACTION_TYPES.SEER_CHECK,
        visibility: VISIBILITY_TYPES.SEER,
        actorId: 'p1',
        content: { targetSeatNo: 2, result: 'werewolf' },
      }),
    ];

    const vars = buildGameReviewVariables({
      winnerFaction: FACTIONS.WEREWOLF,
      totalDays: 2,
      players,
      events,
      speechSummaries: [],
      judgments: [],
    });

    expect(vars.timeline).toContain('2号位(agent-2/werewolf)发言：我是预言家');
    expect(vars.timeline).toContain('2号位(agent-2/werewolf)狼队商议：今晚刀1号');
    expect(vars.timeline).toContain('预言家查验 2号位 → 狼人');
    expect(vars.roster).toContain('1号位(agent-1/seer)');
  });

  it('有摘要的发言用摘要，无摘要回落原文截断', () => {
    const events = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.SPEECH,
        day: 1,
        actorId: 'p1',
        content: { seatNo: 1, speech: '这是第一天的原文' },
      }),
      ev({
        sequence: 12,
        actionType: ACTION_TYPES.SPEECH,
        day: 1,
        actorId: 'p1',
        content: { seatNo: 1, speech: '这是同一天的第二次公开发言' },
      }),
      ev({
        sequence: 15,
        actionType: ACTION_TYPES.SPEECH,
        day: 1,
        visibility: VISIBILITY_TYPES.WOLF,
        actorId: 'p1',
        content: { seatNo: 1, speech: '今晚私下讨论刀2号' },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.SPEECH,
        day: 3,
        actorId: 'p1',
        content: { seatNo: 1, speech: '啊'.repeat(300) },
      }),
    ];

    const vars = buildGameReviewVariables({
      winnerFaction: FACTIONS.VILLAGER,
      totalDays: 3,
      players,
      events,
      speechSummaries: [{ day: 1, seatNo: 1, summary: '自称预言家' }],
      judgments: [],
    });

    expect(vars.timeline).toContain('第1天 1号位(agent-1/seer)公开发言摘要：自称预言家');
    expect(vars.timeline).not.toContain('发言：自称预言家');
    expect(vars.timeline.indexOf('公开发言摘要：自称预言家')).toBeGreaterThan(
      vars.timeline.indexOf('第3天'),
    );
    expect(vars.timeline.match(/自称预言家/g)).toHaveLength(1);
    expect(vars.timeline).not.toContain('这是第一天的原文');
    expect(vars.timeline).not.toContain('这是同一天的第二次公开发言');
    expect(vars.timeline).toContain('第1天 1号位(agent-1/seer)狼队商议：今晚私下讨论刀2号');
    expect(vars.timeline).toContain('…'); // 第3天没有摘要，回落原文并截断
  });

  it('只列出被判为非 good 的行为', () => {
    const vars = buildGameReviewVariables({
      winnerFaction: FACTIONS.VILLAGER,
      totalDays: 2,
      players,
      events: [],
      speechSummaries: [],
      judgments: [
        {
          playerId: 'p1',
          actionType: ACTION_TYPES.VOTE,
          day: 1,
          targetSeatNo: 2,
          verdict: 'good',
          score: 90,
          reasoning: '这条不该出现',
        },
        {
          playerId: 'p2',
          actionType: ACTION_TYPES.VOTE,
          day: 2,
          targetSeatNo: 1,
          verdict: 'poor',
          score: 20,
          reasoning: '这条应该出现',
        },
      ],
    });

    expect(vars.weakDecisions).not.toContain('这条不该出现');
    expect(vars.weakDecisions).toContain('这条应该出现');
  });
});

describe('buildReflectionVariables 玩家反思', () => {
  const me = player({ playerId: 'p1', seatNo: 1, role: ROLES.SEER, isWinner: false });
  const base = {
    me,
    opponents: [
      { agentName: 'agent-2', seatNo: 2, role: ROLES.WEREWOLF, faction: FACTIONS.WEREWOLF },
    ],
    review: {
      narrative: '狼队靠首日悍跳成功',
      turningPoints: [{ day: 1, description: '误票金水' }],
    },
    myJudgments: [],
    mySpeeches: [],
    trustMisreads: [],
    performance: null,
    existingModels: [],
  };

  it('只渲染自己的发言与自己的思考', () => {
    const vars = buildReflectionVariables({
      ...base,
      mySpeeches: [
        {
          day: 1,
          phase: 'speech',
          visibility: VISIBILITY_TYPES.PUBLIC,
          speech: '我查杀2号',
          thinking: '我的内心推理',
        },
      ],
    });

    expect(vars.mySpeeches).toContain('第1天 [阶段=speech，可见性=public]：我查杀2号');
    expect(vars.mySpeeches).toContain('我的内心推理');
  });

  it('识人偏差只保留判断与真相相反的条目', () => {
    const vars = buildReflectionVariables({
      ...base,
      trustMisreads: [
        // 给狼打高信任 —— 是误判
        {
          seatNo: 2,
          agentName: 'agent-2',
          trustScore: 85,
          suspicious: false,
          actualFaction: FACTIONS.WEREWOLF,
          relationship: null,
        },
        // 给好人打高信任 —— 判断正确，不该出现
        {
          seatNo: 3,
          agentName: 'agent-3',
          trustScore: 80,
          suspicious: false,
          actualFaction: FACTIONS.VILLAGER,
          relationship: null,
        },
      ],
    });

    expect(vars.trustMisreads).toContain('2号位(agent-2)');
    expect(vars.trustMisreads).not.toContain('3号位(agent-3)');
  });

  it('狼人高信任 teammate、低信任敌方不算识人误判', () => {
    const wolf = player({
      playerId: 'p2',
      seatNo: 2,
      role: ROLES.WEREWOLF,
      faction: FACTIONS.WEREWOLF,
    });
    const vars = buildReflectionVariables({
      ...base,
      me: wolf,
      trustMisreads: [
        {
          seatNo: 3,
          agentName: 'wolf-teammate',
          trustScore: 90,
          suspicious: false,
          actualFaction: FACTIONS.WEREWOLF,
          relationship: 'teammate',
        },
        {
          seatNo: 4,
          agentName: 'villager-enemy',
          trustScore: 20,
          suspicious: true,
          actualFaction: FACTIONS.VILLAGER,
          relationship: null,
        },
        {
          seatNo: 5,
          agentName: 'trusted-enemy',
          trustScore: 80,
          suspicious: false,
          actualFaction: FACTIONS.VILLAGER,
          relationship: null,
        },
      ],
    });

    expect(vars.trustMisreads).not.toContain('wolf-teammate');
    expect(vars.trustMisreads).not.toContain('villager-enemy');
    expect(vars.trustMisreads).toContain('trusted-enemy');
  });

  it('复盘正文与关键转折一并给出，同桌真实身份可见', () => {
    const vars = buildReflectionVariables(base);

    expect(vars.review).toContain('狼队靠首日悍跳成功');
    expect(vars.review).toContain('第1天：误票金水');
    expect(vars.opponents).toContain('2号位 agent-2：真实身份 werewolf');
  });

  it('无数据时给出占位文案而非空串', () => {
    const vars = buildReflectionVariables(base);

    expect(vars.weakActions).toBe('（没有可用的不佳行为记录：可能全部为 good，或尚未评分）');
    expect(vars.trustMisreads).toBe('（没有明显的识人偏差）');
    expect(vars.mySpeeches).toBe('（本局没有发言）');
    expect(vars.existingModels).toBe('（此前没有对手建模）');
  });
});
