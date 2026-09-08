import { afterEach, expect, it, vi } from 'vitest';
import { apiClient } from './api-client';

afterEach(() => vi.unstubAllGlobals());

it('A/B 开始入口提交 1 对已冻结配置的 ON/OFF，并立即启动', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ experimentId: 'e', gameIds: ['on', 'off'] }),
  });
  vi.stubGlobal('fetch', fetch);
  await apiClient.startAbGames({ rulesetId: 'standard6p', agentIds: ['a', 'b'] });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toMatch(/\/evaluation\/batch$/);
  expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toEqual({
    rulesetId: 'standard6p',
    agentIds: ['a', 'b'],
    count: 1,
    shuffleAgents: false,
    experiment: { paired: true, start: true },
  });
});
