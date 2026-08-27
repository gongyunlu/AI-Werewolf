import { QueryGamesSchema } from './query-games.dto';

describe('QueryGamesSchema', () => {
  it('接受 ruleset slug', () => {
    const result = QueryGamesSchema.parse({ rulesetId: 'standard6p' });

    expect(result.rulesetId).toBe('standard6p');
  });

  it('把单个 status 查询参数转换成数组', () => {
    const result = QueryGamesSchema.parse({ status: 'running' });

    expect(result.status).toEqual(['running']);
  });

  it('拒绝包含路径字符的 ruleset slug', () => {
    expect(() => QueryGamesSchema.parse({ rulesetId: '../v1' })).toThrow();
  });
});
