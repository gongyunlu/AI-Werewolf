import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe, cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { GameWorkerService } from './game-queue/game-worker.service';
import { JudgeWorkerService } from './evaluation/judge.worker';
import { ReflectionWorkerService } from './reflection/reflection.worker';
import { MaintenanceWorkerService } from './memory-maintenance/maintenance.worker';
import { GameExecutorService } from './game-executor/game-executor.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AI Werewolf API')
    .setDescription('AI 狼人杀后端接口')
    .setVersion('0.1')
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
  SwaggerModule.setup('api/docs', app, document);

  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('API_PORT', { infer: true }));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const workers = [
      app.get(GameWorkerService).worker,
      app.get(JudgeWorkerService).worker,
      app.get(ReflectionWorkerService).worker,
      app.get(MaintenanceWorkerService).worker,
    ];
    // 先停止接单并中断本进程的对局，再释放数据库、Redis 和 tracing。
    await Promise.all(workers.map((worker) => worker.pause(true)));
    try {
      await app.get(GameExecutorService).interruptActiveGames();
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
      await app.close();
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
bootstrap();
