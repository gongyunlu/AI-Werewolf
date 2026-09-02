import { resolveStructuredOutputMethod } from './structured-output-method';

describe('resolveStructuredOutputMethod', () => {
  it.each(['glm-4-plus', 'GLM-4-Flash', ' glm-4.5 ', 'minimax-m3'])(
    '%s 使用 functionCalling',
    (model) => {
      expect(resolveStructuredOutputMethod(model)).toBe('functionCalling');
    },
  );

  it.each(['kimi-k2', 'deepseek-v4-flash', 'doubao-seed-1-6'])('%s 使用 jsonSchema', (model) => {
    expect(resolveStructuredOutputMethod(model)).toBe('jsonSchema');
  });
});
