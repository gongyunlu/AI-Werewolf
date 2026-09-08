import { ACTION_TYPES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import { getActionLabel, isJudgeableAction, renderActionLine } from './action-catalog';

describe('行为目录', () => {
  it('登记的决策类行为同时具备判定、文案、渲染三项能力', () => {
    const decisions = [
      { actionType: ACTION_TYPES.VOTE, content: { voterSeatNo: 1, targetSeatNo: 2 } },
      { actionType: ACTION_TYPES.SEER_CHECK, content: { targetSeatNo: 3, result: 'werewolf' } },
      { actionType: ACTION_TYPES.WITCH_SAVE, content: { targetSeatNo: 3, saved: true } },
      { actionType: ACTION_TYPES.WITCH_POISON, content: { targetSeatNo: 5, used: true } },
      {
        actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
        content: { sheriffSeatNo: 3, direction: 'left' },
      },
    ];

    for (const { actionType, content } of decisions) {
      expect(isJudgeableAction(actionType, content)).toBe(true);
      expect(getActionLabel(actionType)).not.toBe(actionType);
      expect(renderActionLine(actionType, content, VISIBILITY_TYPES.PUBLIC)).not.toBeNull();
    }
  });

  it('未用药不算决策，但仍在上下文里可见', () => {
    expect(isJudgeableAction(ACTION_TYPES.WITCH_SAVE, { saved: false })).toBe(false);
    expect(isJudgeableAction(ACTION_TYPES.WITCH_POISON, { used: false })).toBe(false);
    expect(
      renderActionLine(ACTION_TYPES.WITCH_SAVE, { saved: false }, VISIBILITY_TYPES.WITCH),
    ).toBe('女巫未使用解药');
  });

  it('弃票不算独立决策，但在上下文中明确显示为弃票', () => {
    expect(isJudgeableAction(ACTION_TYPES.VOTE, { targetSeatNo: 0 })).toBe(false);
    expect(isJudgeableAction(ACTION_TYPES.VOTE, {})).toBe(false);
    expect(
      renderActionLine(
        ACTION_TYPES.VOTE,
        { voterSeatNo: 5, targetSeatNo: 0, voteRound: 0 },
        VISIBILITY_TYPES.PUBLIC,
      ),
    ).toBe('5号位弃票');
  });

  it('系统发言顺序公告进入上下文，但不单独评分', () => {
    const content = {
      speechOrder: [2, 3, 4, 5, 6, 1],
      startSeatNo: 2,
      direction: 'clockwise',
      reason: 'time_rule_25_clockwise',
      message: '今天的发言顺序: 2 → 3 → 4 → 5 → 6 → 1',
    };
    expect(isJudgeableAction(ACTION_TYPES.SPEECH_ORDER_DETERMINED, content)).toBe(false);
    expect(
      renderActionLine(ACTION_TYPES.SPEECH_ORDER_DETERMINED, content, VISIBILITY_TYPES.PUBLIC),
    ).toBe(content.message);
  });

  it('狼刀作为团队决策送评，并渲染进上下文', () => {
    expect(isJudgeableAction(ACTION_TYPES.WOLF_KILL, { targetSeatNo: 3 })).toBe(true);
    expect(
      renderActionLine(ACTION_TYPES.WOLF_KILL, { targetSeatNo: 3 }, VISIBILITY_TYPES.WOLF_KILL),
    ).toBe('狼人刀了 3号位');
    expect(renderActionLine(ACTION_TYPES.WOLF_KILL, {}, VISIBILITY_TYPES.WOLF_KILL)).toBe(
      '狼人空刀',
    );
  });

  it('发言按可见频道区分公开发言与狼队商议', () => {
    const content = { seatNo: 5, speech: '今晚刀3号' };
    expect(renderActionLine(ACTION_TYPES.SPEECH, content, VISIBILITY_TYPES.PUBLIC)).toBe(
      '5号位发言：今晚刀3号',
    );
    expect(renderActionLine(ACTION_TYPES.SPEECH, content, VISIBILITY_TYPES.WOLF)).toBe(
      '5号位狼队商议：今晚刀3号',
    );
  });

  it('过长发言在上下文里被截断', () => {
    const speech = '啊'.repeat(200);
    const line = renderActionLine(
      ACTION_TYPES.SPEECH,
      { seatNo: 1, speech },
      VISIBILITY_TYPES.PUBLIC,
    );
    expect(line).toContain('…');
    expect(line!.length).toBeLessThan(speech.length);
  });

  it('法官播报渲染正文 content.content', () => {
    expect(
      renderActionLine(
        ACTION_TYPES.JUDGE_ANNOUNCE,
        { content: '天亮了，昨晚是平安夜' },
        VISIBILITY_TYPES.PUBLIC,
      ),
    ).toBe('天亮了，昨晚是平安夜');
    expect(
      renderActionLine(ACTION_TYPES.JUDGE_ANNOUNCE, { content: '' }, VISIBILITY_TYPES.PUBLIC),
    ).toBeNull();
    expect(renderActionLine(ACTION_TYPES.JUDGE_ANNOUNCE, {}, VISIBILITY_TYPES.PUBLIC)).toBeNull();
  });

  it('未登记的行为退化为不送评、原始文案、不进上下文', () => {
    expect(isJudgeableAction(ACTION_TYPES.PHASE_CHANGED, {})).toBe(false);
    expect(getActionLabel(ACTION_TYPES.PHASE_CHANGED)).toBe(ACTION_TYPES.PHASE_CHANGED);
    expect(renderActionLine(ACTION_TYPES.PHASE_CHANGED, {}, VISIBILITY_TYPES.PUBLIC)).toBeNull();
  });
});
