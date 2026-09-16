import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export interface ModelRequest {
  model: string;
  seat: number;
  day: number;
  kind: 'decision' | 'stream' | 'coordination';
  action: string;
  messages: BaseMessage[] | string;
  signal: AbortSignal;
}

type ModelSchema = { properties?: Record<string, unknown> };

/** 只替换模型接口；上下文、结构校验、重试和领域节点仍由生产代码执行。 */
export class ScriptedGameModel {
  readonly requests: ModelRequest[] = [];
  beforeRequest?: (request: ModelRequest) => Promise<void> | void;
  decisionOverride?: (request: ModelRequest, decision: object) => object;

  constructor(readonly winner: 'villager' | 'werewolf' = 'villager') {}

  private async request(
    model: string,
    messages: BaseMessage[] | string,
    signal: AbortSignal,
    kind: ModelRequest['kind'],
    schema?: ModelSchema,
  ): Promise<ModelRequest> {
    signal.throwIfAborted();
    const prompt = typeof messages === 'string' ? messages : String(messages[0].content);
    const decisionSchema = schema?.properties?.decision as { anyOf?: unknown[] } | undefined;
    const decision = (decisionSchema?.anyOf?.[0] ?? decisionSchema) as
      { properties?: { action?: { enum?: string[]; const?: string } } } | undefined;
    const action =
      decision?.properties?.action?.enum?.[0] ?? decision?.properties?.action?.const ?? '';
    const request: ModelRequest = {
      model,
      seat: Number(model.replace('mock-seat-', '')),
      kind,
      action,
      messages,
      signal,
      day: Number(prompt.match(/当前第(\d+)天/)?.[1] ?? 1),
    };
    this.requests.push(request);
    await this.beforeRequest?.(request);
    signal.throwIfAborted();
    return request;
  }

  create(model: string) {
    return {
      model,
      withStructuredOutput: (schema: ModelSchema) => ({
        invoke: async (messages: BaseMessage[], options: { signal: AbortSignal }) => {
          const request = await this.request(model, messages, options.signal, 'decision', schema);
          const { day, action } = request;
          let decision: object;
          switch (action) {
            case 'propose_kill':
              decision = { action, targetSeatNo: day === 1 ? 5 : 6 };
              break;
            case 'antidote':
              decision =
                this.winner === 'villager' ? { action, targetSeatNo: 5 } : { action: 'skip' };
              break;
            case 'poison':
              decision =
                this.winner === 'villager' && day === 2
                  ? { action, targetSeatNo: 2 }
                  : { action: 'skip' };
              break;
            case 'check_identity':
              decision = { action, targetSeatNo: day === 1 ? 1 : 2 };
              break;
            case 'explode':
              decision = { action: 'hold' };
              break;
            case 'cast_vote':
              decision = { action, targetSeatNo: this.winner === 'villager' ? 1 : 3 };
              break;
            default:
              throw new Error(`未配置模型桩动作：${action}`);
          }
          const parsed = {
            reasoning: '按本场测试预设行动。',
            decision: this.decisionOverride?.(request, decision) ?? decision,
          };
          return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
        },
      }),
      stream: async (messages: BaseMessage[], options: { signal: AbortSignal }) => {
        const request = await this.request(
          model,
          messages,
          options.signal,
          model === 'mock-coordinator' ? 'coordination' : 'stream',
        );
        return (async function* () {
          for (const content of model === 'mock-coordinator'
            ? ['YES']
            : [`${request.seat}号发言。`, '请结合公开信息判断。']) {
            options.signal.throwIfAborted();
            yield { content };
          }
        })();
      },
      invoke: async (messages: string, options: { signal: AbortSignal }) => {
        await this.request(model, messages, options.signal, 'coordination');
        return { content: 'NO' };
      },
    };
  }
}
