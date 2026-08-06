import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI Werewolf API')
    .setDescription('AI 狼人杀后端接口')
    .setVersion('0.1')
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
  SwaggerModule.setup('api/docs', app, document);

  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('API_PORT', { infer: true }));

  // 显式响应终止信号，触发 Nest 生命周期钩子并关闭 HTTP server：
  // 一是让 --watch 重启时端口及时释放，二是让未来接入的 DB/Redis 连接池能正常关闭
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
bootstrap();
