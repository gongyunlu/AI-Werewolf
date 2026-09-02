import { z } from 'zod';
import { ReflectionOutputSchema } from './reflection-schema';

function validLesson(overrides: Record<string, unknown> = {}) {
  return {
    title: '标题',
    trigger: '触发条件',
    action: '行动',
    evidence: '证据',
    importance: 0.5,
    role: 'seer',
    scenario: 'vote',
    ...overrides,
  };
}

function parseWithLessons(lessons: unknown[]) {
  return ReflectionOutputSchema.safeParse({
    summary: '复盘',
    lessons,
    playerModels: [],
  });
}

describe('ReflectionOutputSchema.lessons', () => {
  it('可生成结构化调用使用的 JSON Schema，且 role/scenario 在 required 中', () => {
    const schema = z.toJSONSchema(ReflectionOutputSchema) as unknown as {
      properties: { lessons: { items: { required: string[] } } };
    };

    expect(schema.properties.lessons.items.required).toEqual(
      expect.arrayContaining(['role', 'scenario']),
    );
  });

  it('接受合法 role/scenario', () => {
    expect(parseWithLessons([validLesson({ role: 'seer', scenario: 'vote' })]).success).toBe(true);
  });

  it('拒绝省略 role/scenario，避免静默扩大为 any', () => {
    const { role: _role, ...withoutRole } = validLesson();
    const { scenario: _scenario, ...withoutScenario } = validLesson();

    expect(parseWithLessons([withoutRole]).success).toBe(false);
    expect(parseWithLessons([withoutScenario]).success).toBe(false);
    expect(parseWithLessons([validLesson({ role: null })]).success).toBe(false);
    expect(parseWithLessons([validLesson({ scenario: null })]).success).toBe(false);
  });

  it('role/scenario 接受 any（不限）', () => {
    expect(parseWithLessons([validLesson({ role: 'any', scenario: 'any' })]).success).toBe(true);
  });

  it('拒绝非法 role', () => {
    expect(parseWithLessons([validLesson({ role: 'not_a_role' })]).success).toBe(false);
  });

  it('拒绝非法 scenario', () => {
    expect(parseWithLessons([validLesson({ scenario: 'not_a_scenario' })]).success).toBe(false);
  });
});

describe('ReflectionOutputSchema.playerModels', () => {
  it('拒绝同一对手的重复建模，促使结构化输出重试', () => {
    const result = ReflectionOutputSchema.safeParse({
      summary: '复盘',
      lessons: [],
      playerModels: [
        { agentName: '阿二', content: '第一版', confidence: 0.5 },
        { agentName: ' 阿二 ', content: '第二版', confidence: 0.8 },
      ],
    });

    expect(result.success).toBe(false);
  });
});
