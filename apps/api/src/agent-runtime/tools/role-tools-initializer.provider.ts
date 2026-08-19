import { Injectable, OnModuleInit } from '@nestjs/common';

/**
 * 角色工具注册初始化器
 *
 * @deprecated 两阶段决策模式已移除工具调用，改用 Structured Output。
 * 保留此类仅为保持架构完整性，初始化逻辑已清空。
 *
 * 历史架构：
 * - 在模块初始化时自动注册所有角色的工具构建器
 * - 新增角色只需实现工具函数并在此注册
 * - 支持预言家、女巫、狼人等角色的工具动态注册
 *
 * 当前架构：
 * - 所有决策通过两阶段模式完成（streamReasoning + generateDecision）
 * - Node 层使用 JSON Schema 定义结构化输出
 */
@Injectable()
export class RoleToolsInitializer implements OnModuleInit {
  onModuleInit() {
    // No-op: 工具注册已废弃
  }
}
