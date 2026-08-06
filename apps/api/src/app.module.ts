import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { GamesModule } from './games/games.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AgentsModule } from './agents/agents.module';
import { DebugModule } from './debug/debug.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 数组前项优先：.env.local（本地私密覆盖）> .env（仓库/生产默认）
      envFilePath: [join(__dirname, '../../../.env.local'), join(__dirname, '../../../.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    GamesModule,
    AgentsModule,
    DebugModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
