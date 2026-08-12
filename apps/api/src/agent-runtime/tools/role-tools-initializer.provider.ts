import { Injectable, OnModuleInit } from '@nestjs/common';
import { roleToolsRegistry } from './role-tools.registry';
import { createCheckIdentityTool } from './check-identity.tool';
import { createUseAntidoteTool, createUsePoisonTool } from './witch.tool';
import { createWolfChatTool, createProposeKillTool } from './werewolf.tool';

/**
 * 角色工具注册初始化器
 *
 * 在模块初始化时自动注册所有角色的工具构建器
 *
 * 新增角色时：
 * 1. 实现工具函数（如 create-hunter-shoot.tool.ts）
 * 2. 在此文件中导入并在 onModuleInit 中注册
 * 3. 无需修改 AgentToolsFactory
 */
@Injectable()
export class RoleToolsInitializer implements OnModuleInit {
  onModuleInit() {
    // 预言家工具
    roleToolsRegistry.register('seer', (ctx) => [createCheckIdentityTool(ctx)]);

    // 女巫工具（已拆分为两个阶段）
    roleToolsRegistry.register('witch_antidote', (ctx) => [createUseAntidoteTool(ctx)]);

    roleToolsRegistry.register('witch_poison', (ctx) => [createUsePoisonTool(ctx)]);

    // 狼人工具
    roleToolsRegistry.register('werewolf', (ctx) => [
      createWolfChatTool(ctx),
      createProposeKillTool(ctx),
    ]);

    // 平民工具（无特殊工具，只有默认的 skip_action）
    roleToolsRegistry.register('villager', () => []);

    /**
     * 未来扩展示例：
     *
     * // 猎人工具
     * roleToolsRegistry.register('hunter', (ctx) => [
     *   createHunterShootTool(ctx),
     * ]);
     *
     * // 守卫工具
     * roleToolsRegistry.register('guard', (ctx) => [
     *   createGuardProtectTool(ctx),
     * ]);
     */
  }
}
