import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import CallbackHandler, { Langfuse } from 'langfuse-langchain';
import type { Env } from '../config/env.validation';

/** SDK 默认只记录采样参数；补充实际调用协议，按字段选取以排除连接凭证。 */
class ModelRequestCallbackHandler extends CallbackHandler {
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
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly client: Langfuse | null;

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
      this.client = new Langfuse({ publicKey, secretKey, baseUrl });
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
    };
    const tags = [runName, modelName, ...(scenario ? [scenario] : [])];
    const root = this.client?.trace({
      name: runName,
      sessionId: gameId,
      userId: playerId,
      metadata,
      tags,
    });
    return {
      callbacks: root ? [new ModelRequestCallbackHandler({ root, updateRoot: true })] : [],
      metadata,
      tags,
      runName,
    };
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
