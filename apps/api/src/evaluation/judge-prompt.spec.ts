import { ACTION_TYPES, FACTIONS, ROLES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import { buildJudgePrompt, type JudgeEventInput } from './judge-prompt';

function ev(
  partial: Partial<JudgeEventInput> & { sequence: number; actionType: string },
): JudgeEventInput {
  return {
    day: 1,
    visibility: VISIBILITY_TYPES.PUBLIC,
    actorId: null,
    content: {},
    ...partial,
  };
}

describe('buildJudgePrompt 视角还原', () => {
  const baseInput = {
    playerId: 'p2',
    playerSeatNo: 2,
    playerRole: ROLES.WEREWOLF,
    playerFaction: FACTIONS.WEREWOLF,
    isAlive: true,
    teammates: [5],
    decision: {
      sequence: 100,
      actionType: ACTION_TYPES.VOTE,
      day: 2,
      targetSeatNo: 1,
      thinking: '我觉得1号像预言家，先投他',
    },
    events: [] as JudgeEventInput[],
  };

  it('包含私有信息：角色与狼队友', () => {
    const { user } = buildJudgePrompt({ ...baseInput, events: [] });
    expect(user).toContain('狼人');
    expect(user).toContain('队友座位号 [5]');
  });

  it('只包含 sequence < 决策 且可见的事件，不含上帝视角', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.SEER_CHECK,
        visibility: VISIBILITY_TYPES.SEER,
        content: { targetSeatNo: 3, result: 'werewolf' },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        content: { targetSeatNo: 3 },
      }),
      ev({
        sequence: 30,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: 'p1',
        content: { seatNo: 1, speech: '我是预言家' },
      }),
      ev({
        sequence: 200,
        actionType: ACTION_TYPES.VOTE,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: 'p1',
        content: { voterSeatNo: 1, targetSeatNo: 2 },
      }),
    ];

    const { user } = buildJudgePrompt({ ...baseInput, events });

    // 狼人看不到预言家查验（seer 频道）
    expect(user).not.toContain('预言家查验');
    // 狼人看得到刀口
    expect(user).toContain('狼人刀了 3号位');
    // 决策之后的未来事件被截断
    expect(user).not.toContain('1号位投票给 2号位');
    // 待评估决策本身 + 思考过程
    expect(user).toContain('投票（目标：1号位）');
    expect(user).toContain('我觉得1号像预言家');
  });

  it('女巫存活且未用解药时可看到刀口', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        content: { targetSeatNo: 3 },
      }),
    ];

    const { user } = buildJudgePrompt({
      ...baseInput,
      playerRole: ROLES.WITCH,
      playerFaction: FACTIONS.VILLAGER,
      teammates: [],
      decision: { sequence: 20, actionType: ACTION_TYPES.WITCH_SAVE, day: 1, targetSeatNo: 3 },
      events,
    });

    expect(user).toContain('狼人刀了 3号位');
  });

  it('女巫已用解药后看不到刀口', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        content: { targetSeatNo: 3 },
      }),
      ev({
        sequence: 15,
        actionType: ACTION_TYPES.WITCH_SAVE,
        visibility: VISIBILITY_TYPES.WITCH,
        actorId: 'p2',
        content: { targetSeatNo: 3, saved: true },
      }),
    ];

    const { user } = buildJudgePrompt({
      ...baseInput,
      playerRole: ROLES.WITCH,
      playerFaction: FACTIONS.VILLAGER,
      teammates: [],
      decision: { sequence: 20, actionType: ACTION_TYPES.WITCH_POISON, day: 2, targetSeatNo: 5 },
      events,
    });

    expect(user).not.toContain('狼人刀了 3号位');
  });

  it('超过 20 条可见事件时只保留最近 20 条', () => {
    const events: JudgeEventInput[] = Array.from({ length: 25 }, (_, i) =>
      ev({
        sequence: i + 1,
        actionType: ACTION_TYPES.VOTE,
        actorId: 'p1',
        content: { voterSeatNo: i + 1, targetSeatNo: 2 },
      }),
    );

    const { user } = buildJudgePrompt({ ...baseInput, events });

    // 最早 5 条（voterSeatNo 1..5）被截断，可见信息从 voterSeatNo 6 开始
    expect(user).toContain('【决策时点可见信息】\n6号位投票给 2号位');
  });

  it('评估投票决策时排除同轮（同 day）其他投票，避免视角泄漏', () => {
    const events: JudgeEventInput[] = [
      // 同 day（decision.day=2）的投票 —— 应被排除
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.VOTE,
        actorId: 'p1',
        content: { voterSeatNo: 1, targetSeatNo: 2 },
        day: 2,
      }),
      // 前一 day 的投票 —— 应保留
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.VOTE,
        actorId: 'p3',
        content: { voterSeatNo: 3, targetSeatNo: 4 },
        day: 1,
      }),
    ];

    const { user } = buildJudgePrompt({ ...baseInput, events });

    expect(user).not.toContain('1号位投票给 2号位'); // 同 day 被排除
    expect(user).toContain('3号位投票给 4号位'); // 不同 day 保留
  });
});
