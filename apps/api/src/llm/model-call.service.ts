import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Env } from '../config/env.validation';
import type { TraceConfig } from '../observability/langfuse.service';
import {
  resolveModelCapability,
  structuredProtocol,
  type ModelCapability,
} from './model-capability';
import { throwIfAborted } from './abort.utils';
import { ModelCallGuard, ModelCallError, type ModelCallMode } from './model-call-guard';
import {
  createStreamProgress,
  recordStreamProgress,
  ModelStreamProgressHandler,
} from './model-stream-progress';
import { parseJsonOutput } from './parse-json-output';
import { canonicalJson } from './canonical-json';

/** 单次调用使用的接入端点；缺省时回落到环境变量里的默认接入。密钥只在本进程内传递。 */
export interface ModelAccess {
  baseUrl: string;
  /** 持久结果重放不需要凭据；函数仅在准备实际请求时求值，不进入快照。 */
  apiKey: string | (() => Promise<string>);
  capability?: ModelCapability;
}

export interface ModelRequestSettings {
  temperature?: number;
  timeoutMs?: number;
  disableReasoning?: boolean;
}

/** 模型传输、结构协议和调用故障边界；不读取游戏状态或提交业务效果。 */
@Injectable()
export class ModelCallService {
  private readonly logger = new Logger(ModelCallService.name);
  private readonly modelGuard: ModelCallGuard;
  constructor(private readonly configService: ConfigService<Env, true>) {
    this.modelGuard = new ModelCallGuard({
      timeoutMs: configService.get('LLM_CALL_TIMEOUT_MS'),
      firstChunkTimeoutMs: configService.get('LLM_FIRST_CHUNK_TIMEOUT_MS'),
      streamIdleTimeoutMs: configService.get('LLM_STREAM_IDLE_TIMEOUT_MS'),
      streamTimeoutMs: configService.get('LLM_STREAM_MAX_DURATION_MS'),
      minSamples: configService.get('LLM_CIRCUIT_MIN_SAMPLES'),
      cooldownMs: configService.get('LLM_CIRCUIT_COOLDOWN_MS'),
    });
  }
  /** 端点与凭证：Agent 自带接入选自带，否则用环境变量默认接入。 */
  resolveAccess(access?: ModelAccess): ModelAccess {
    return (
      access ?? {
        baseUrl: this.configService.get('ARK_BASE_URL'),
        apiKey: this.configService.get('ARK_API_KEY'),
      }
    );
  }

  capability(modelName: string, access?: ModelAccess) {
    return (
      access?.capability ??
      resolveModelCapability(
        modelName,
        this.resolveAccess(access).baseUrl,
        this.configService.get('MODEL_CAPABILITIES'),
      )
    );
  }

  private async createModel(
    modelName: string,
    access?: ModelAccess,
    options?: ModelRequestSettings,
  ): Promise<ChatOpenAI> {
    const { baseUrl, apiKey } = this.resolveAccess(access);
    // 发言链路里思考由独立调用生成，供应商思维链属纯冗余，关掉可省下大部分生成耗时。
    const disableReasoning =
      options?.disableReasoning === true && this.capability(modelName, access).disableReasoning;
    return new ChatOpenAI({
      apiKey: typeof apiKey === 'function' ? await apiKey() : apiKey,
      model: modelName,
      configuration: { baseURL: baseUrl },
      streaming: true,
      timeout:
        options?.timeoutMs ?? this.configService.get('LLM_FIRST_CHUNK_TIMEOUT_MS') ?? 300_000,
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      maxRetries: 0,
      ...(disableReasoning ? { modelKwargs: { thinking: { type: 'disabled' } } } : {}),
    });
  }

  async run<T>(
    modelName: string,
    call: (signal: AbortSignal, reportProgress: () => void) => Promise<T>,
    signal?: AbortSignal,
    diagnostics?: Record<string, unknown>,
    mode: ModelCallMode = 'invoke',
    access?: ModelAccess,
    maxDurationMs?: number,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      // 熔断按「端点 + 模型」隔离：换端点不能复用另一条链路的故障状态。
      return await this.modelGuard.run(
        `${this.resolveAccess(access).baseUrl}:${modelName}`,
        call,
        signal,
        mode,
        maxDurationMs,
      );
    } catch (error) {
      if (error instanceof ModelCallError) {
        this.logger.warn({
          message: error.message,
          modelName,
          ...diagnostics,
          failureCode: error.code,
          elapsedMs: Date.now() - startedAt,
          ...error.details,
          retryAt: error.retryAt,
        });
      }
      throw error;
    }
  }

  async streamText(
    modelName: string,
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
    onToken?: (token: string) => void,
    trace?: TraceConfig,
    access?: ModelAccess,
    settings?: ModelRequestSettings,
    validate?: z.ZodType<string>,
  ): Promise<string> {
    const model = await this.createModel(modelName, access, {
      disableReasoning: true,
      ...settings,
    });
    const progress = { ...trace?.metadata, runName: trace?.runName, ...createStreamProgress() };
    let fullContent = '';
    let pendingWhitespace = '';
    try {
      return await this.run(
        modelName,
        async (callSignal, reportProgress) => {
          const stream = await model.stream(messages, { ...trace, signal: callSignal });
          for await (const chunk of stream) {
            throwIfAborted(callSignal);
            recordStreamProgress(progress, chunk, reportProgress);
            if (typeof chunk.content !== 'string' || !chunk.content) continue;
            fullContent += chunk.content;
            // 空白本身不是有效预览，避免一次空输出把空格流到下一次正文前面。
            if (!fullContent.trim()) pendingWhitespace += chunk.content;
            else {
              onToken?.(pendingWhitespace + chunk.content);
              pendingWhitespace = '';
            }
          }
          if (progress.finishReason === 'length' || !fullContent.trim())
            throw new ModelCallError('invalid_output', undefined, undefined, {
              reason: progress.finishReason === 'length' ? 'truncated_output' : 'empty_output',
            });
          return validate ? validate.parse(fullContent.trim()) : fullContent;
        },
        signal,
        progress,
        'stream',
        access,
        settings?.timeoutMs,
      );
    } catch (error) {
      if (error instanceof ModelCallError && onToken && fullContent.trim())
        error.details.partialOutput = true;
      throw error;
    }
  }

  async structured<S extends z.ZodType>(
    modelName: string,
    outputSchema: S,
    baseMessages: BaseMessage[],
    traceFor: (retry: boolean) => TraceConfig,
    signal?: AbortSignal,
    wireSchema: Record<string, unknown> = z.toJSONSchema(outputSchema),
    access?: ModelAccess,
    settings?: ModelRequestSettings,
    repair?: string,
  ): Promise<z.infer<S>> {
    const baseModel = await this.createModel(modelName, access, settings);

    const capability = this.capability(modelName, access);
    const method = capability.protocol;
    const model = baseModel.withStructuredOutput(JSON.parse(canonicalJson(wireSchema)), {
      name: 'extract',
      method,
      includeRaw: true,
    });
    const outputProtocol = structuredProtocol(method);
    // 业务模板描述 JSON 内容；工具模式还需明确结果的提交方式。
    const structuredMessages =
      method === 'functionCalling'
        ? [...baseMessages, new HumanMessage(outputProtocol)]
        : method === 'jsonMode'
          ? [
              ...baseMessages,
              new HumanMessage(
                `${outputProtocol}仅输出 JSON，不要附加说明。Schema：${canonicalJson(wireSchema)}`,
              ),
            ]
          : baseMessages;

    const trace = traceFor(false);

    let previousResponse: { content: AIMessage['content']; toolCalls: unknown } | undefined;
    // 保留结束原因：工具参数为空可能源于截断，不能一律归为字段错误。
    const invokeDecision = (messages: BaseMessage[], callTrace: TraceConfig) => {
      const diagnostics = {
        ...callTrace.metadata,
        runName: callTrace.runName,
        ...createStreamProgress(),
      };
      return this.run(
        modelName,
        async (callSignal, reportProgress) => {
          const progressHandler = new ModelStreamProgressHandler(
            diagnostics,
            callSignal,
            reportProgress,
          );
          let output: unknown;
          try {
            // invoke 聚合完整流后才解析；进度回调不发布候选内容，也不执行工具。
            const response = await model.invoke(messages, {
              ...callTrace,
              signal: callSignal,
              callbacks: [...callTrace.callbacks, progressHandler],
            });
            const raw = response.raw as AIMessage;
            // 仅回传本次模型输出供纠错，不携带供应商推理、用量或追踪元数据。
            previousResponse = {
              content: raw.content,
              toolCalls: raw.additional_kwargs.tool_calls ?? [],
            };
            const finishReason = raw.response_metadata?.finish_reason ?? diagnostics.finishReason;
            if (typeof finishReason === 'string') diagnostics.finishReason = finishReason;
            diagnostics.inputTokens = raw.usage_metadata?.input_tokens;
            diagnostics.outputTokens = raw.usage_metadata?.output_tokens;
            if (finishReason === 'length') {
              throw new ModelCallError('invalid_output', undefined, undefined, {
                reason: 'truncated_output',
                finishReason,
                inputTokens: diagnostics.inputTokens,
                outputTokens: diagnostics.outputTokens,
              });
            }
            if (raw.invalid_tool_calls?.length) {
              throw new ModelCallError('invalid_output', undefined, undefined, {
                reason: 'parse_error',
              });
            }
            // 流解析器会容忍未闭合 JSON，完整结果仍须通过严格语法校验。
            output = response.parsed;
            if (method !== 'functionCalling' && typeof raw.content === 'string')
              output = parseJsonOutput(raw.content, capability.allowCodeFence);
            const toolOutputs = (raw.additional_kwargs.tool_calls ?? []).map((tool) => ({
              name: tool.function.name,
              args: JSON.parse(tool.function.arguments) as unknown,
            }));
            if (method === 'functionCalling') {
              if (toolOutputs.length !== 1 || toolOutputs[0].name !== 'extract')
                throw new ModelCallError('invalid_output', undefined, undefined, {
                  reason: 'schema_validation',
                });
              output = toolOutputs[0].args;
            } else if (toolOutputs.length) {
              throw new ModelCallError('invalid_output', undefined, undefined, {
                reason: 'schema_validation',
              });
            }
          } catch (error) {
            // 解析在 invoke 内部就抛错时，模型原文不会随异常返回；改从流式分片里取回，
            // 否则重试拿不到任何待修正的内容，只能把同样的输入再发一遍。
            if (
              !previousResponse &&
              (progressHandler.rawContent || progressHandler.rawToolArguments)
            ) {
              previousResponse = {
                content: progressHandler.rawContent,
                toolCalls: progressHandler.rawToolArguments
                  ? [
                      {
                        function: {
                          name: progressHandler.rawToolName,
                          arguments: progressHandler.rawToolArguments,
                        },
                      },
                    ]
                  : [],
              };
            }
            // OpenAI SDK 的 JSON Schema 解析也可能直接抛原生解析异常。
            if (
              error instanceof SyntaxError ||
              (error instanceof Error && error.constructor.name === 'LengthFinishReasonError')
            ) {
              throw new ModelCallError('invalid_output', { cause: error }, undefined, {
                reason: error instanceof SyntaxError ? 'parse_error' : 'truncated_output',
                ...(error instanceof SyntaxError ? {} : { finishReason: 'length' }),
              });
            }
            throw error;
          }
          return outputSchema.parse(output);
        },
        signal,
        diagnostics,
        'stream',
        access,
        settings?.timeoutMs,
      );
    };
    try {
      return await invokeDecision(
        repair ? [...structuredMessages, new HumanMessage(repair)] : structuredMessages,
        trace,
      );
    } catch (error) {
      if (error instanceof ModelCallError && error.code === 'invalid_output') {
        const issues =
          error.cause instanceof z.ZodError
            ? error.cause.issues.map(({ path, message }) => ({ path, message }))
            : [];
        throw new ModelOutputError(error, previousResponse, issues);
      }
      throw error;
    }
  }
}

/** 仅供本次应用修正使用的模型原文；不把凭据、供应商私有推理或服务对象放入恢复资料。 */
export class ModelOutputError extends ModelCallError {
  constructor(
    error: ModelCallError,
    readonly response: unknown,
    readonly issues: unknown,
  ) {
    super(error.code, { cause: error }, error.retryAt, error.details);
  }
}
