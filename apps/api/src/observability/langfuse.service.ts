import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import CallbackHandler, { Langfuse } from 'langfuse-langchain';
import { randomUUID } from 'node:crypto';
import type { ActionSource } from './action-source';
import type { Env } from '../config/env.validation';
import { readPromptOrigin, type PromptOrigin } from './langfuse-project';

/** 旧 SDK 更新 observation 时漏传 environment，dual 服务会将其重置为 default。 */
class ObservationLangfuse extends Langfuse {
  private readonly observationEnvironment: string | undefined;

  constructor(options: ConstructorParameters<typeof Langfuse>[0]) {
    super(options);
    this.observationEnvironment = options?.environment;
  }

  override _updateGeneration(body: Parameters<Langfuse['_updateGeneration']>[0]) {
    return super._updateGeneration({
      ...body,
      environment: body.environment ?? this.observationEnvironment,
    });
  }

  override _updateSpan(body: Parameters<Langfuse['_updateSpan']>[0]) {
    return super._updateSpan({
      ...body,
      environment: body.environment ?? this.observationEnvironment,
    });
  }
}

/** SDK 默认只记录采样参数；补充实际调用协议，按字段选取以排除连接凭证。 */
class ModelRequestCallbackHandler extends CallbackHandler {
  frozenPrompt?: { name: string; version: number };

  /** 3.38.20 只从 Prompt 链登记版本；直接 invoke/stream 需在生成入口显式传原生 prompt。 */
  override async handleGenerationStart(
    ...args: Parameters<CallbackHandler['handleGenerationStart']>
  ) {
    try {
      const [llm, messages, runId, parentRunId, extra, tags, metadata, name] = args;
      this.generateTrace(
        name ?? llm.id.at(-1) ?? 'model',
        runId,
        parentRunId,
        tags,
        metadata,
        messages as never,
      );
      const invocation = (extra?.invocation_params ?? {}) as Record<string, unknown>;
      const fields = [
        'temperature',
        'max_tokens',
        'top_p',
        'frequency_penalty',
        'presence_penalty',
        'request_timeout',
      ];
      this.langfuse.generation({
        id: runId,
        traceId: this.traceId,
        parentObservationId: parentRunId ?? this.rootObservationId,
        name: name ?? llm.id.at(-1),
        input: messages,
        model: String(invocation.model ?? metadata?.ls_model_name ?? ''),
        modelParameters: Object.fromEntries(
          fields.filter((key) => invocation[key] != null).map((key) => [key, invocation[key]]),
        ) as never,
        metadata,
        // SDK 的原生序列化只读取 name/version/isFallback；不重新获取 production 或替换正文。
        prompt: this.frozenPrompt as Parameters<Langfuse['generation']>[0]['prompt'],
        level: tags?.includes('langsmith:hidden') ? 'DEBUG' : undefined,
      });
    } catch {
      // 3.38.20 的 chat/llm start 不 await 此方法，必须在这里消化拒绝。
      Logger.warn('生成追踪不可用，继续调用模型', ModelRequestCallbackHandler.name);
    }
  }

  override async handleChatModelStart(
    ...args: Parameters<CallbackHandler['handleChatModelStart']>
  ) {
    const invocation = args[4]?.invocation_params ?? {};
    const fields = [
      'model',
      'stream',
      'temperature',
      'top_p',
      'max_tokens',
      'max_completion_tokens',
      'frequency_penalty',
      'presence_penalty',
      'seed',
      'stop',
      'tools',
      'tool_choice',
      'response_format',
    ];
    const modelRequest = Object.fromEntries(
      fields.filter((key) => invocation[key] !== undefined).map((key) => [key, invocation[key]]),
    );
    args[6] = { ...args[6], modelRequest };
    return super.handleChatModelStart(...args);
  }
}

/** 单次 LLM 调用的追踪配置，展开后直接传给 LangChain 的 invoke/stream */
export interface TraceConfig {
  callbacks: CallbackHandler[];
  metadata: Record<string, unknown>;
  tags: string[];
  runName: string;
  observationId?: string;
}

/**
 * LangFuse 追踪服务
 *
 * 复用客户端的上报队列，每次调用各自持有 CallbackHandler 与根 trace，
 * 避免并发调用互相覆盖 traceId，也让独立流式调用带上 session / user。
 *
 * 未配置凭证时静默降级：callbacks 为空数组，不影响对局流程。
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly client: Langfuse | null;
  private projectOrigin?: PromptOrigin;

  constructor(private readonly configService: ConfigService<Env, true>) {
    const publicKey = this.configService.get('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.configService.get('LANGFUSE_SECRET_KEY');
    const baseUrl = this.configService.get('LANGFUSE_HOST');

    if (!publicKey || !secretKey) {
      this.logger.warn('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 未配置，追踪已关闭');
      this.client = null;
      return;
    }

    try {
      this.client = new ObservationLangfuse({
        publicKey,
        secretKey,
        baseUrl,
        ...(this.configService.get('NODE_ENV') === 'test'
          ? { environment: 'werewolf-integration-test' }
          : {}),
      });
      this.logger.log(`LangFuse 追踪已启用: ${baseUrl}`);
    } catch (error) {
      this.client = null;
      this.logger.error(
        `LangFuse 初始化失败，追踪已关闭: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) return;
    this.projectOrigin = await readPromptOrigin(
      this.client,
      this.configService.get('LANGFUSE_HOST'),
    );
    if (!this.projectOrigin)
      this.logger.warn('Langfuse 项目未确认，本进程暂不关联原生 Prompt 版本');
  }

  /**
   * 构造单次调用的追踪配置
   *
   * gameId 映射为 session、playerId 映射为 user，
   * 面板上即可按「一局」聚合调用链、按「一个玩家」筛选其全部推理。
   */
  trace(params: {
    runName: string;
    gameId: string;
    playerId: string;
    modelName: string;
    scenario?: string;
    seatNo?: number | null;
    role?: string | null;
    promptName?: string;
    promptVersion?: number | null;
    promptSource?: 'langfuse' | 'local_release' | 'local_default';
    promptOrigin?: PromptOrigin;
    source?: ActionSource;
  }): TraceConfig {
    const {
      runName,
      gameId,
      playerId,
      modelName,
      scenario,
      seatNo,
      role,
      promptName,
      promptVersion,
    } = params;

    const metadata = {
      langfuseSessionId: gameId,
      langfuseUserId: playerId,
      gameId,
      playerId,
      modelName,
      ...(scenario ? { scenario } : {}),
      ...(seatNo === null || seatNo === undefined ? {} : { seatNo }),
      ...(role ? { role } : {}),
      ...(promptName ? { promptName } : {}),
      ...(promptVersion === null || promptVersion === undefined ? {} : { promptVersion }),
      ...(params.promptSource ? { promptSource: params.promptSource } : {}),
      ...(params.promptOrigin ? { promptOrigin: params.promptOrigin } : {}),
      ...(params.source
        ? { actionKey: params.source.actionKey, attemptId: params.source.attemptId }
        : {}),
    };
    const tags = [runName, modelName, ...(scenario ? [scenario] : [])];
    // 标识不依赖观测队列是否可用，追踪失败仍允许领域提交保存本次来源。
    const observationId = params.source ? randomUUID() : undefined;
    let callback: ModelRequestCallbackHandler | undefined;
    try {
      // 评估运行根由评分服务发布；并发目标只写子调用，不能改写运行名称与归属。
      const root =
        params.source && scenario === 'judge'
          ? undefined
          : this.client?.trace({
              ...(params.source ? { id: params.source.traceId } : {}),
              name: params.source ? 'player-action' : runName,
              sessionId: gameId,
              userId: playerId,
              metadata,
              tags,
            });
      const parent =
        params.source && this.client
          ? this.client.span({
              id: observationId,
              traceId: params.source.traceId,
              parentObservationId: params.source.attemptId,
              name: runName,
              metadata,
            })
          : root;
      callback = parent
        ? new ModelRequestCallbackHandler({ root: parent, updateRoot: true })
        : undefined;
      if (
        callback &&
        params.promptSource === 'langfuse' &&
        promptName &&
        promptVersion != null &&
        this.projectOrigin &&
        params.promptOrigin &&
        params.promptOrigin.baseUrl === this.projectOrigin.baseUrl &&
        params.promptOrigin.projectId === this.projectOrigin.projectId
      )
        callback.frozenPrompt = { name: promptName, version: promptVersion };
    } catch {
      callback = undefined;
      this.logger.warn('模型追踪不可用，继续游戏');
    }
    return {
      callbacks: callback ? [callback] : [],
      metadata,
      tags,
      runName,
      observationId,
    };
  }

  startAttempt(source: ActionSource, gameId: string, playerId: string): void {
    try {
      this.client?.trace({
        id: source.traceId,
        name: 'player-action',
        sessionId: gameId,
        userId: playerId,
        metadata: { actionKey: source.actionKey },
      });
      this.client?.span({
        id: source.attemptId,
        traceId: source.traceId,
        name: 'generation-attempt',
        startTime: new Date(source.startedAt),
        metadata: { actionKey: source.actionKey, attemptId: source.attemptId },
      });
    } catch {
      this.logger.warn('行动追踪不可用，继续游戏');
    }
  }

  /** 进程退出前把队列里未上报的调用刷出去，否则短命进程的追踪会丢 */
  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdownAsync();
    } catch (error) {
      this.logger.warn(
        `LangFuse 上报刷新失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
