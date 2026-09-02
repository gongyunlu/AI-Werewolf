import { ACTION_TYPES, AGENT_SCENARIOS, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import { buildScenarioQuery } from './scenario-query';

describe('buildScenarioQuery', () => {
  it('身份与场景转中文，事件渲染进 query', () => {
    const query = buildScenarioQuery({
      role: 'seer',
      scenario: AGENT_SCENARIOS.DAY_SPEECH,
      day: 2,
      events: [
        {
          actionType: ACTION_TYPES.SEER_CHECK,
          visibility: VISIBILITY_TYPES.SEER,
          content: { targetSeatNo: 3, result: 'werewolf' },
        },
        {
          actionType: ACTION_TYPES.VOTE,
          visibility: VISIBILITY_TYPES.PUBLIC,
          content: { voterSeatNo: 1, targetSeatNo: 3 },
        },
      ],
    });

    expect(query).toContain('我是预言家');
    expect(query).toContain('第2天白天发言');
    expect(query).toContain('预言家查验 3号位 → 狼人');
    expect(query).toContain('1号位投票给 3号位');
  });

  it('未登记的角色退化到英文原始值', () => {
    const query = buildScenarioQuery({
      role: 'fox',
      scenario: AGENT_SCENARIOS.VOTE,
      day: 1,
      events: [],
    });
    expect(query).toContain('我是fox');
    expect(query).toContain('第1天投票');
  });

  it('role 为 null 时不输出身份段', () => {
    const query = buildScenarioQuery({
      role: null,
      scenario: AGENT_SCENARIOS.LAST_WORDS,
      day: 3,
      events: [],
    });
    expect(query).not.toContain('我是');
    expect(query).toContain('第3天遗言');
  });

  it('事件超过上限只取最近 N 条', () => {
    const events = Array.from({ length: 25 }, (_, i) => ({
      actionType: ACTION_TYPES.SPEECH,
      visibility: VISIBILITY_TYPES.PUBLIC,
      content: { seatNo: 1, speech: `第${i}条发言` },
    }));
    const query = buildScenarioQuery({
      role: 'villager',
      scenario: AGENT_SCENARIOS.DAY_SPEECH,
      day: 1,
      events,
    });
    expect(query).not.toContain('第0条发言');
    expect(query).not.toContain('第4条发言');
    expect(query).toContain('第5条发言');
    expect(query).toContain('第24条发言');
  });
});
