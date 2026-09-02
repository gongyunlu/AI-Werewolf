import { JudgeOutputSchema, SpeechJudgeOutputSchema, validateSpeechOutput } from './judge-schema';

const item = (index: number) => ({
  verdict: 'good' as const,
  score: 80,
  reasoning: 'x',
  index,
});

describe('SpeechJudgeOutputSchema', () => {
  it('缺 index 时 schema 仍解析通过，回填交给 judge.service 运行时处理', () => {
    const result = SpeechJudgeOutputSchema.safeParse({
      items: [
        { verdict: 'good', score: 80, reasoning: '第一条' },
        { verdict: 'poor', score: 30, reasoning: '第二条' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('部分缺 index 时 schema 仍解析通过，由 validateSpeechOutput 拦截', () => {
    const result = SpeechJudgeOutputSchema.safeParse({
      items: [
        { verdict: 'good', score: 80, reasoning: '第一条', index: 1 },
        { verdict: 'poor', score: 30, reasoning: '第二条' },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('带 index 时照常解析', () => {
    const result = SpeechJudgeOutputSchema.safeParse({
      items: [{ verdict: 'good', score: 80, reasoning: '第一条', index: 2 }],
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.items[0].index).toBe(2);
  });

  it('拒绝空 items', () => {
    expect(SpeechJudgeOutputSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('JudgeOutputSchema', () => {
  it('三档 verdict 与 0-100 分边界', () => {
    expect(
      JudgeOutputSchema.safeParse({ verdict: 'good', score: 100, reasoning: 'ok' }).success,
    ).toBe(true);
    expect(
      JudgeOutputSchema.safeParse({ verdict: 'bad', score: 50, reasoning: 'ok' }).success,
    ).toBe(false);
    expect(
      JudgeOutputSchema.safeParse({ verdict: 'good', score: 101, reasoning: 'ok' }).success,
    ).toBe(false);
  });
});

describe('validateSpeechOutput', () => {
  it('index 合法唯一时通过，乱序也接受（映射只认 index 不认顺序）', () => {
    expect(() => validateSpeechOutput([item(2), item(1), item(3)], 3)).not.toThrow();
  });

  it('数量不匹配时抛错', () => {
    expect(() => validateSpeechOutput([item(1), item(2)], 3)).toThrow('数量不匹配');
  });

  it('index 越界时抛错', () => {
    expect(() => validateSpeechOutput([item(1), item(4), item(3)], 3)).toThrow('越界');
  });

  it('index 缺失时抛错（拦截部分漏标）', () => {
    expect(() =>
      validateSpeechOutput(
        [
          { verdict: 'good', score: 80, reasoning: 'x', index: 1 },
          { verdict: 'poor', score: 30, reasoning: 'x' },
        ],
        2,
      ),
    ).toThrow('缺失');
  });

  it('index 重复时抛错', () => {
    expect(() => validateSpeechOutput([item(1), item(1), item(3)], 3)).toThrow('重复');
  });
});
