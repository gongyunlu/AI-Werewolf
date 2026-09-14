import { canDisableReasoning, resolveModelCapability } from './model-capability';

describe('模型的结构化输出能力', () => {
  it.each(['minimax-m3', ' MINIMAX-M3 ', 'minimax-M3'])(
    '%s 走 jsonMode，文本解析需要剥掉代码围栏',
    (modelName) => {
      expect(resolveModelCapability(modelName)).toEqual({
        protocol: 'jsonMode',
        allowCodeFence: true,
      });
    },
  );

  it('minimax-m3 的精确规则优先于 minimax 前缀规则', () => {
    expect(resolveModelCapability('minimax-m3').protocol).toBe('jsonMode');
    expect(resolveModelCapability('minimax-v2').protocol).toBe('functionCalling');
  });

  it('deepseek-flash 走 jsonMode，不能用 json_schema 或工具调用', () => {
    expect(resolveModelCapability('deepseek-flash').protocol).toBe('jsonMode');
  });

  it.each(['glm-4-plus', 'GLM-5.3', ' glm-4.5 '])('%s 走工具调用', (modelName) => {
    expect(resolveModelCapability(modelName).protocol).toBe('functionCalling');
  });

  // 方舟上的 deepseek 系与 Kimi 实测支持 json_schema，改走 jsonMode 会白白丢掉服务端约束。
  it.each(['kimi-k3', 'deepseek-v4-pro', 'deepseek-v4-flash', 'doubao-seed-1-6'])(
    '%s 走 jsonSchema',
    (modelName) => {
      expect(resolveModelCapability(modelName)).toEqual({
        protocol: 'jsonSchema',
        allowCodeFence: false,
      });
    },
  );
});

describe('关闭思维链的适用范围', () => {
  it.each([
    'deepseek-v4-pro',
    ' DEEPSEEK-V4-Flash ',
    'doubao-seed-2.1-turbo',
    'doubao-seed-evolving',
    'kimi-k3',
    'minimax-m3',
  ])('%s 可以关闭思维链', (modelName) => {
    expect(canDisableReasoning(modelName)).toBe(true);
  });

  // glm 对 thinking.type=disabled 返回 400，会把整轮发言打断，必须排除。
  it.each(['glm-5.2', 'glm-5.3', 'glm-4-plus'])('%s 不传该开关', (modelName) => {
    expect(canDisableReasoning(modelName)).toBe(false);
  });

  it('未实测的模型一律不传，避免 400 打断整轮发言', () => {
    expect(canDisableReasoning('deepseek-flash')).toBe(false);
    expect(canDisableReasoning('minimax-v2')).toBe(false);
    expect(canDisableReasoning('some-new-model')).toBe(false);
  });
});
