import { describe, expect, it } from 'vitest';
import { buildAccessPatch } from './agent-access';
import type { Agent } from './api-client';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: '阿九',
  defaultModelName: 'deepseek-chat',
  memoryLabel: '钱九',
  isActive: true,
  baseUrl: null,
  hasApiKey: false,
  apiKeyMasked: null,
  tag: null,
  notes: null,
  ...overrides,
});

const DS = 'https://deepseek.example/v1';

describe('接入配置的表单折算', () => {
  it('没有自带接入且什么都没填时不提交任何字段', () => {
    expect(buildAccessPatch(agent(), { baseUrl: '', apiKey: '' })).toEqual({});
  });

  it('首次配置必须同时给出端点与密钥', () => {
    expect(() => buildAccessPatch(agent(), { baseUrl: DS, apiKey: '' })).toThrow(
      '首次配置接入端点时必须同时填写密钥',
    );
    expect(() => buildAccessPatch(agent(), { baseUrl: '', apiKey: 'sk-1' })).toThrow(
      '清空接入端点时不需要填写新密钥',
    );
    expect(buildAccessPatch(agent(), { baseUrl: DS, apiKey: 'sk-1' })).toEqual({
      baseUrl: DS,
      apiKey: 'sk-1',
    });
  });

  it('已有密钥时只换端点不会把密钥清掉', () => {
    const configured = agent({ baseUrl: DS, hasApiKey: true, apiKeyMasked: '****-key' });
    expect(
      buildAccessPatch(configured, { baseUrl: 'https://relay.example/v1', apiKey: '' }),
    ).toEqual({ baseUrl: 'https://relay.example/v1' });
  });

  it('端点不变时只提交新密钥，可用于单独轮换密钥', () => {
    const configured = agent({ baseUrl: DS, hasApiKey: true, apiKeyMasked: '****-key' });
    expect(buildAccessPatch(configured, { baseUrl: DS, apiKey: 'sk-2' })).toEqual({
      apiKey: 'sk-2',
    });
  });

  it('清空端点时把密钥一起清掉，保持成对约束', () => {
    const configured = agent({ baseUrl: DS, hasApiKey: true, apiKeyMasked: '****-key' });
    expect(buildAccessPatch(configured, { baseUrl: '   ', apiKey: '' })).toEqual({
      baseUrl: null,
      apiKey: null,
    });
  });
});
