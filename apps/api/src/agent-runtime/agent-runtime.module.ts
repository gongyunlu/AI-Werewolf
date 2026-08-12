import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentToolsFactory } from './tools/agent-tools.factory';
import { RoleToolsInitializer } from './tools/role-tools-initializer.provider';
import { MemoryModule } from '../memory/memory.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SkillLoaderService } from '../skills/skill-loader.service';

@Module({
  imports: [ConfigModule, PrismaModule, MemoryModule],
  providers: [AgentRuntimeService, AgentToolsFactory, SkillLoaderService, RoleToolsInitializer],
  exports: [AgentRuntimeService, AgentToolsFactory, SkillLoaderService],
})
export class AgentRuntimeModule {}
