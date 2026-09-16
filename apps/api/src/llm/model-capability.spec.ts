import { resolveModelCapability } from './model-capability';
const ark = 'https://ark.cn-beijing.volces.com/api/plan/v3';
it('已验证方舟精确型号保留协议和 reasoning 开关', () => {
  expect(resolveModelCapability('glm-5.3', ark)).toEqual({
    protocol: 'functionCalling',
    allowCodeFence: false,
    disableReasoning: false,
  });
  expect(resolveModelCapability('deepseek-v4-pro', ark)).toEqual({
    protocol: 'jsonSchema',
    allowCodeFence: false,
    disableReasoning: true,
  });
  expect(resolveModelCapability('minimax-m3', ark).protocol).toBe('jsonMode');
});
it('同名模型换端点、未知型号和相似前缀均需声明', () => {
  expect(() => resolveModelCapability('glm-5.3', 'https://unknown.invalid')).toThrow('能力');
  expect(() => resolveModelCapability('glm-next', ark)).toThrow('能力');
});
it('显式声明精确匹配，不改变其他路由', () => {
  const entries = JSON.stringify([
    {
      baseUrl: 'https://custom.invalid/v1',
      model: 'custom',
      protocol: 'jsonMode',
      allowCodeFence: false,
      disableReasoning: false,
    },
  ]);
  expect(resolveModelCapability('custom', 'https://custom.invalid/v1/', entries).protocol).toBe(
    'jsonMode',
  );
  expect(() => resolveModelCapability('custom', 'https://other.invalid/v1', entries)).toThrow(
    '能力',
  );
});
