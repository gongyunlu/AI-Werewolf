import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { resolve } from 'node:path';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { MemoryModule } from './memory.module';
import { MemoryService } from './memory.service';

const repositoryRoot = resolve(__dirname, '../../../..');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [resolve(repositoryRoot, '.env.local'), resolve(repositoryRoot, '.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    MemoryModule,
  ],
})
class MemoryEmbeddingBackfillModule {}

function readPositiveIntegerOption(name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

const logger = new Logger('MemoryEmbeddingBackfill');

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(MemoryEmbeddingBackfillModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  try {
    const count = await app.get(MemoryService).backfillEmbeddings({
      batchSize: readPositiveIntegerOption('batch-size'),
      limit: readPositiveIntegerOption('limit'),
    });
    logger.log(`Memory embedding 回填完成，共处理 ${count} 条`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
