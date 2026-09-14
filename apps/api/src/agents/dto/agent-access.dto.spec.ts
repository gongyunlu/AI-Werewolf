import { CreateAgentSchema } from './create-agent.dto';
import { UpdateAgentSchema } from './update-agent.dto';

const createInput = {
  name: '阿九',
  defaultModelName: 'deepseek-chat',
  memoryLabel: '钱九',
};

describe('Agent 接入配置入参', () => {
  it('两者都不填时可以新建，表示走环境变量里的默认接入', () => {
    const parsed = CreateAgentSchema.parse(createInput);
    expect(parsed.baseUrl).toBeUndefined();
    expect(parsed.apiKey).toBeUndefined();
  });

  it('只填其中一个时拒绝，避免留下配不成对的接入配置', () => {
    expect(() =>
      CreateAgentSchema.parse({ ...createInput, baseUrl: 'https://deepseek.example/v1' }),
    ).toThrow('baseUrl 与 apiKey 必须同时提供');
    expect(() => CreateAgentSchema.parse({ ...createInput, apiKey: 'sk-abcd1234' })).toThrow(
      'baseUrl 与 apiKey 必须同时提供',
    );
  });

  it('非 URL 的端点直接拒绝', () => {
    expect(() =>
      CreateAgentSchema.parse({ ...createInput, baseUrl: 'deepseek.example', apiKey: 'sk-1' }),
    ).toThrow();
  });

  it('更新时字段缺省表示保持原值，与显式 null 区分开', () => {
    const kept = UpdateAgentSchema.parse({ notes: '只改备注' });
    expect(kept).not.toHaveProperty('baseUrl');
    const cleared = UpdateAgentSchema.parse({ baseUrl: null, apiKey: null });
    expect(cleared.baseUrl).toBeNull();
    expect(cleared.apiKey).toBeNull();
  });

  it('更新时空对象不构成一次有效修改', () => {
    expect(() => UpdateAgentSchema.parse({})).toThrow('至少需要更新一个字段');
  });
});
