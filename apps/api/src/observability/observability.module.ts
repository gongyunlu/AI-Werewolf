import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { LangfuseService } from './langfuse.service';
import type { Env } from '../config/env.validation';

/**
 * 可观测性模块：结构化日志（Pino）+ LLM 调用链追踪（LangFuse）
 *
 * 用 forRootAsync 而非 forRoot：forRoot 的配置在模块定义期求值，
 * 那时 ConfigModule 还没加载 .env，LOG_LEVEL 会读不到。
 */
@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // 生产输出 JSON 交给日志采集；开发走 pino-pretty 便于肉眼读
          transport:
            config.get('NODE_ENV', { infer: true }) === 'production'
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss',
                    ignore: 'pid,hostname',
                    singleLine: true,
                  },
                },
          // 默认序列化会打出整个 req/res，噪音太大，只留排查需要的字段
          serializers: {
            req: (req: { method: string; url: string; id?: unknown }) => ({
              method: req.method,
              url: req.url,
              id: req.id,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          // SSE 是长连接，逐条请求日志意义不大，健康检查同理
          autoLogging: {
            ignore: (req: { url?: string }) =>
              !!req.url && (req.url.includes('/stream') || req.url.includes('/health')),
          },
        },
      }),
    }),
  ],
  providers: [LangfuseService],
  exports: [LangfuseService],
})
export class ObservabilityModule {}
