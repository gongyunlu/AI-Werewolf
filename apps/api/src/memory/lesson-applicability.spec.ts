import { lessonApplies } from './lesson-applicability';
import { retrieveFrozenMemories, type FrozenMemory } from '../evaluation/experiment-snapshot';

it('首夜尚无讨论或救人事实时，不能采纳依赖这些事实的经验', () => {
  expect(
    lessonApplies({ conditions: ['public_discussion', 'has_saved'] }, [
      'first_night',
      'antidote_unused',
    ]),
  ).toBe(false);
  expect(
    lessonApplies({ conditions: ['public_discussion', 'has_saved'] }, [
      'public_discussion',
      'has_saved',
    ]),
  ).toBe(true);
  expect(lessonApplies({ conditions: ['after_first_night'] }, ['first_night'])).toBe(false);
  expect(lessonApplies({}, ['first_night'])).toBe(true);
});

it('冻结检索先排除条件不成立的高相似经验，保留适用经验', () => {
  const memories: FrozenMemory[] = [
    { id: 'wrong', metadata: { conditions: ['has_saved'] }, embedding: [1, 0] },
    { id: 'right', metadata: { conditions: ['first_night'] }, embedding: [0.9, 0.1] },
  ].map((m) =>
    Object.assign(m, {
      title: m.id,
      content: m.id,
      importance: 1,
      agentId: 'a',
      label: 'l',
      createdAt: '2026-09-07T00:00:00Z',
      type: 'lesson',
      rank: 1,
      metadata: { ...m.metadata, role: 'witch', scenario: 'night_action' },
    }),
  );
  const result = retrieveFrozenMemories(memories, {
    agentId: 'a',
    label: 'l',
    opponentAgentIds: [],
    role: 'witch',
    scenario: 'night_action',
    queryVector: [1, 0],
    facts: ['first_night'],
  });
  expect(result.lessons.map((m) => m.id)).toEqual(['right']);
});
