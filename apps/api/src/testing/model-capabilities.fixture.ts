/** 脚本供应商的能力显式声明，测试不借用真实端点的型号规则。 */
export function testModelCapabilities(baseUrl: string, models: string[]): string {
  return JSON.stringify(
    models.map((model) => ({
      baseUrl,
      model,
      protocol:
        model === 'minimax-m3' || model === 'deepseek-flash'
          ? 'jsonMode'
          : model.startsWith('glm') || model === 'minimax-v2'
            ? 'functionCalling'
            : 'jsonSchema',
      allowCodeFence: model === 'minimax-m3' || model === 'deepseek-flash',
      disableReasoning: ['deepseek-v4', 'doubao-seed', 'kimi', 'minimax-m3'].some((prefix) =>
        model.startsWith(prefix),
      ),
    })),
  );
}
