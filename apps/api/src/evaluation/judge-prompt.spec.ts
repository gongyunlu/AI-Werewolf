import { ACTION_TYPES, FACTIONS, ROLES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import {
  buildJudgePrompt,
  buildRefineUser,
  buildSpeechJudgePromptVariables,
  type JudgeEventInput,
} from './judge-prompt';

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

  it('无目标座位的警长决策按目录渲染真实方向，不伪装成放弃行动', () => {
    const { user } = buildJudgePrompt({
      ...baseInput,
      decision: {
        sequence: 100,
        actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
        day: 2,
        targetSeatNo: null,
        content: { sheriffSeatNo: 2, direction: 'left' },
      },
    });

    expect(user).toContain('2号位警长决定从左手（逆时针）开始发言');
    expect(user).not.toContain('放弃行动');
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

  it('女巫已用解药后保留交药前刀口，交药后刀口不可见', () => {
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
      ev({
        sequence: 18,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        day: 2,
        content: { targetSeatNo: 5 },
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

    // 交药前看过的刀口保留（累积知识，报银水合法）；交药后不再被唤醒，看不到新刀口
    expect(user).toContain('狼人刀了 3号位');
    expect(user).not.toContain('狼人刀了 5号位');
  });

  it('女巫跳过解药后仍可看到后续刀口', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.WITCH_SAVE,
        visibility: VISIBILITY_TYPES.WITCH,
        actorId: 'p2',
        content: { targetSeatNo: 0, saved: false },
      }),
      ev({
        sequence: 15,
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
      decision: { sequence: 20, actionType: ACTION_TYPES.WITCH_SAVE, day: 2, targetSeatNo: 3 },
      events,
    });

    expect(user).toContain('狼人刀了 3号位');
  });

  it('超过 40 条可见事件时只保留最近 40 条', () => {
    const events: JudgeEventInput[] = Array.from({ length: 45 }, (_, i) =>
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

  it('发言进入可见上下文，但不泄漏他人的内心思考', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: 'p1',
        content: { seatNo: 1, speech: '我是预言家，查杀4号', thinking: '我要悍跳骗票' },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.WOLF,
        actorId: 'p5',
        content: { seatNo: 5, speech: '今晚刀3号', round: 1 },
      }),
    ];

    const { user } = buildJudgePrompt({ ...baseInput, events });

    expect(user).toContain('1号位发言：我是预言家，查杀4号');
    expect(user).toContain('5号位狼队商议：今晚刀3号');
    expect(user).not.toContain('我要悍跳骗票');
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

describe('buildSpeechJudgePromptVariables 整局时间线', () => {
  const baseInput = {
    playerId: 'p2',
    playerSeatNo: 2,
    playerRole: ROLES.WITCH,
    playerFaction: FACTIONS.VILLAGER,
    deathDay: null as number | null,
    teammates: [] as number[],
  };

  it('自己的发言按顺序标号并取原文，他人发言截断', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.SPEECH,
        actorId: 'p1',
        content: { seatNo: 1, speech: '啊'.repeat(200) },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.SPEECH,
        actorId: 'p2',
        content: { seatNo: 2, speech: '我是女巫，昨晚救了3号' },
      }),
      ev({
        sequence: 30,
        actionType: ACTION_TYPES.SPEECH,
        actorId: 'p2',
        day: 2,
        content: { seatNo: 2, speech: '我改口了，我是平民' },
      }),
    ];

    const { variables, targets } = buildSpeechJudgePromptVariables({ ...baseInput, events });

    expect(targets).toEqual([
      { index: 1, sequence: 20, day: 1 },
      { index: 2, sequence: 30, day: 2 },
    ]);
    expect(variables.speechCount).toBe('2');
    expect(variables.timeline).toContain('[发言#1] 第1天 我的发言：我是女巫，昨晚救了3号');
    expect(variables.timeline).toContain('[发言#2] 第2天 我的发言：我改口了，我是平民');
    expect(variables.timeline).toContain('…'); // 他人发言被截断
  });

  it('女巫用掉解药后失去刀口频道，解药事件本身仍可见', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        content: { targetSeatNo: 3 },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.WITCH_SAVE,
        visibility: VISIBILITY_TYPES.WITCH,
        actorId: 'p2',
        content: { targetSeatNo: 3, saved: true },
      }),
      ev({
        sequence: 30,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        day: 2,
        content: { targetSeatNo: 5 },
      }),
    ];

    const { variables } = buildSpeechJudgePromptVariables({ ...baseInput, events });

    expect(variables.timeline).toContain('狼人刀了 3号位');
    expect(variables.timeline).toContain('女巫使用解药救了 3号位');
    expect(variables.timeline).not.toContain('狼人刀了 5号位'); // 解药用掉后不再可见
  });

  it('女巫死亡后失去刀口频道', () => {
    const events: JudgeEventInput[] = [
      ev({
        sequence: 10,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        day: 1,
        content: { targetSeatNo: 4 },
      }),
      ev({
        sequence: 20,
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF_KILL,
        day: 3,
        content: { targetSeatNo: 6 },
      }),
    ];

    const { variables } = buildSpeechJudgePromptVariables({ ...baseInput, deathDay: 2, events });

    expect(variables.timeline).toContain('狼人刀了 4号位');
    expect(variables.timeline).not.toContain('狼人刀了 6号位');
  });
});

describe('buildRefineUser', () => {
  it('拼接原始评估上下文与初评结果', () => {
    const user = buildRefineUser('上下文内容', { verdict: 'good', score: 80, reasoning: '合理' });

    expect(user).toContain('【原始评估上下文】');
    expect(user).toContain('上下文内容');
    expect(user).toContain('【初评结果】');
    expect(user).toContain('"score": 80');
  });
});
