import { ConsolidationOutputSchema } from './memory-consolidate.schema';

describe('ConsolidationOutputSchema', () => {
  it('接受合法的 title 与 content', () => {
    const input = {
      title: '尽早带队',
      content: '当场上出现对跳预言家时，优先站边信息更完整的一方。',
    };
    expect(ConsolidationOutputSchema.parse(input)).toEqual(input);
  });

  it('拒绝空 title', () => {
    expect(() => ConsolidationOutputSchema.parse({ title: '', content: '内容' })).toThrow();
  });

  it('拒绝超长 content', () => {
    expect(() =>
      ConsolidationOutputSchema.parse({ title: '标题', content: 'x'.repeat(301) }),
    ).toThrow();
  });
});
