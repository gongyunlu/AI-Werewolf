type LangfusePrompt = {
  version: number;
  compile(variables?: Record<string, string>): string;
};

export default class CallbackHandler {
  async shutdownAsync(): Promise<void> {}
}

export class Langfuse {
  async getPrompt(): Promise<LangfusePrompt> {
    throw new Error('单元测试未配置 Langfuse prompt mock');
  }
}
