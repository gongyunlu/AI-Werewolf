import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import CallbackHandler from 'langfuse-langchain';
import type { Env } from '../config/env.validation';

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
 * 复用单个 CallbackHandler（内部持有一个带批量上报队列的客户端），
 * 每次调用的会话/用户/标签通过 invoke config 逐次传入，
 * 避免每次调用都新建客户端导致队列无人 flush。
 *
 * 未配置凭证时静默降级：callbacks 为空数组，不影响对局流程。
 */
@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  private readonly handler: CallbackHandler | null;

  constructor(private readonly configService: ConfigService<Env, true>) {
    const publicKey = this.configService.get('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.configService.get('LANGFUSE_SECRET_KEY');
    const baseUrl = this.configService.get('LANGFUSE_HOST');

    if (!publicKey || !secretKey) {
      this.logger.warn('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 未配置，追踪已关闭');
      this.handler = null;
      return;
    }

    try {
      this.handler = new CallbackHandler({ publicKey, secretKey, baseUrl });
      this.logger.log(`LangFuse 追踪已启用: ${baseUrl}`);
    } catch (error) {
      this.handler = null;
      this.logger.error(
        `LangFuse 初始化失败，追踪已关闭: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get enabled(): boolean {
    return this.handler !== null;
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
  }): TraceConfig {
    const { runName, gameId, playerId, modelName, scenario, seatNo, role } = params;

    return {
      callbacks: this.handler ? [this.handler] : [],
      metadata: {
        langfuseSessionId: gameId,
        langfuseUserId: playerId,
        gameId,
        playerId,
        modelName,
        ...(scenario ? { scenario } : {}),
        ...(seatNo === null || seatNo === undefined ? {} : { seatNo }),
        ...(role ? { role } : {}),
      },
      tags: [runName, modelName, ...(scenario ? [scenario] : [])],
      runName,
    };
  }

  /** 进程退出前把队列里未上报的调用刷出去，否则短命进程的追踪会丢 */
  async onModuleDestroy(): Promise<void> {
    if (!this.handler) return;

    try {
      await this.handler.shutdownAsync();
    } catch (error) {
      this.logger.warn(
        `LangFuse 上报刷新失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
