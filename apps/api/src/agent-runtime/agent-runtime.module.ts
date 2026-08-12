import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentToolsFactory } from './tools/agent-tools.factory';
import { RoleToolsInitializer } from './tools/role-tools-initializer.provider';
import { MemoryModule } from '../memory/memory.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SkillLoaderModule } from '../skills/skill-loader.module';
import { PromptLoaderModule } from '../prompts/prompt-loader.module';

@Module({
  imports: [ConfigModule, PrismaModule, MemoryModule, PromptLoaderModule, SkillLoaderModule],
  providers: [AgentRuntimeService, AgentToolsFactory, RoleToolsInitializer],
  exports: [AgentRuntimeService, AgentToolsFactory],
})
export class AgentRuntimeModule {}
