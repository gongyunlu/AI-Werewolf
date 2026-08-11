import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentToolsFactory } from './tools/agent-tools.factory';
import { MemoryModule } from '../memory/memory.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SkillLoaderService } from '../skills/skill-loader.service';

// 引导角色工具注册（必须在模块加载时执行）
import './tools/role-tools.bootstrap';

@Module({
  imports: [
    ConfigModule, // 提供 ConfigService
    PrismaModule, // 提供 PrismaService
    MemoryModule, // 提供 MemoryService
  ],
  providers: [AgentRuntimeService, AgentToolsFactory, SkillLoaderService],
  exports: [AgentRuntimeService, AgentToolsFactory, SkillLoaderService],
})
export class AgentRuntimeModule {}
