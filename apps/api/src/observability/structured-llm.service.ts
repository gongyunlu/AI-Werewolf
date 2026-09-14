import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { LangfuseService } from './langfuse.service';
import { resolveModelCapability } from '../llm/model-capability';
import type { Env } from '../config/env.validation';

/** 一次结构化输出调用的入参 */
export interface StructuredInvokeOptions<T> {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  /** LangFuse 上的 runName，重试会自动追加 -retry */
  runName: string;
  scenario: string;
  gameId: string;
  playerId: string;
  seatNo?: number | null;
  role?: string | null;
  promptName?: string;
  promptVersion?: number | null;
  /** 缺省取 JUDGE_MODEL，再回落 ARK_DEFAULT_MODEL */
  modelName?: string;
}

/**
 * 赛后分析类调用的统一出口：结构化输出 + LangFuse 追踪 + Zod 校验失败单次重试。
 *
 * 与局内 agent-runtime 的区别：不走工具调用、不流式、不需要 AgentRuntime 的角色上下文，
 * 只需要「给一段 prompt，拿回一个符合 schema 的对象」。
 */
@Injectable()
export class StructuredLlmService {
  private readonly logger = new Logger(StructuredLlmService.name);

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly langfuse: LangfuseService,
  ) {}

  async invoke<T>(options: StructuredInvokeOptions<T>): Promise<{ output: T; modelName: string }> {
    const { schema, system, user, runName, scenario, gameId, playerId } = options;
    const modelName: string =
      options.modelName ??
      this.configService.get('JUDGE_MODEL') ??
      this.configService.get('ARK_DEFAULT_MODEL', { infer: true });

    const baseModel = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: false,
      // 单次调用超时：火山方舟偶发 hang 时，5 分钟后抛超时异常而非永远 pending，
      // 否则 concurrency=2 的 worker 槽会被占死、队列堆积。
      timeout: 300_000,
      // 关闭 SDK 默认重试（maxRetries=2 会让 hang 连试 3 次、占槽 15 分钟才抛异常），
      // 交由 BullMQ 的 attempts 重试：job 超时后立即回队列、槽位释放。
      maxRetries: 0,
    });

    const jsonSchema = z.toJSONSchema(schema);
    const model = baseModel.withStructuredOutput(jsonSchema, {
      method: resolveModelCapability(modelName).protocol,
    });
    const traceBase = {
      gameId,
      playerId,
      modelName,
      scenario,
      seatNo: options.seatNo,
      role: options.role,
      promptName: options.promptName,
      promptVersion: options.promptVersion,
    };

    const baseMessages: BaseMessage[] = [
      new SystemMessage(system),
      new HumanMessage(`${user}\n\n请严格按以下 JSON Schema 输出：\n${JSON.stringify(jsonSchema)}`),
    ];

    let output: unknown = await model.invoke(baseMessages, {
      ...this.langfuse.trace({ runName, ...traceBase }),
    });

    // functionCalling 下模型没发工具调用时，LangChain 的解析器返回 undefined。
    // 必须在这里就抛：JSON.stringify(undefined) 得到的是 undefined 而非字符串，
    // 拿它构造 AIMessage 会抛一条读 additional_kwargs 的 TypeError，
    // 把「模型没按格式输出」伪装成无关的类型错误，重试也不会真正发生。
    if (output == null) {
      throw new Error(`[${runName}] ${modelName} 未返回结构化输出（可能未发起工具调用），无法解析`);
    }

    const firstParse = schema.safeParse(output);
    if (!firstParse.success) {
      const issues = firstParse.error.issues.map((i) => i.message).join('；');
      this.logger.warn(`[${runName}] ${modelName} 输出未通过 Zod，触发单次重试: ${issues}`);
      const retryMessages: BaseMessage[] = [
        ...baseMessages,
        new AIMessage(JSON.stringify(output)),
        new HumanMessage(
          `你的输出未通过校验：${issues}\n请修正后重新输出，只输出符合 Schema 的 JSON。`,
        ),
      ];
      output = schema.parse(
        await model.invoke(retryMessages, {
          ...this.langfuse.trace({ runName: `${runName}-retry`, ...traceBase }),
        }),
      );
    }

    return { output: output as T, modelName };
  }

  /**
   * 两段式 reflective 调用：初评 → 反思 → 修正后的结果。
   *
   * 反思复用同一 schema（修正结果直接走 invoke 的解析与单次重试逻辑），仅替换 system 与 user。
   * 固定反思一次、不做循环——judge 打分无 ground truth，语义层问题（上帝视角、理由不支撑）
   * 无法确定性判定「反思后是否更好」，循环只会让分数漂移、成本线性上涨。
   */
  async invokeReflective<T>(
    options: StructuredInvokeOptions<T> & {
      refineSystem: string;
      refinePromptName?: string;
      refinePromptVersion?: number | null;
      refineUser: (first: T) => string;
    },
  ): Promise<{ output: T; modelName: string }> {
    const { refineSystem, refinePromptName, refinePromptVersion, refineUser, ...firstOptions } =
      options;

    const first = await this.invoke(firstOptions);

    const refined = await this.invoke({
      ...firstOptions,
      system: refineSystem,
      user: refineUser(first.output),
      runName: `${options.runName}-refine`,
      promptName: refinePromptName ?? firstOptions.promptName,
      promptVersion: refinePromptVersion ?? firstOptions.promptVersion,
    });

    return refined;
  }
}
