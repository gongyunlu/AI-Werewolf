/**
 * 角色工具注册表
 *
 * @deprecated 两阶段决策模式已移除工具调用，改用 Structured Output。
 * 保留此类仅为保持架构完整性，注册表实现已清空。
 *
 * 历史架构：
 * - 插拔式架构：每个角色注册自己的工具集
 * - 支持运行时动态注册新角色工具
 * - 与场景无关，只关心角色
 *
 * 当前架构：
 * - 所有决策通过两阶段模式完成（streamReasoning + generateDecision）
 * - Node 层使用 JSON Schema 定义结构化输出
 */
class RoleToolsRegistry {
  private registry = new Map<string, any>();

  /**
   * @deprecated 不再使用
   */
  register(_role: string, _toolsFactory: any) {
    // No-op
  }

  /**
   * @deprecated 不再使用
   */
  getTools(_role: string, _ctx: any): any[] {
    return [];
  }

  /**
   * @deprecated 不再使用
   */
  hasRole(_role: string): boolean {
    return false;
  }

  /**
   * @deprecated 不再使用
   */
  getRegisteredRoles(): string[] {
    return [];
  }
}

/**
 * 全局角色工具注册表实例
 *
 * @deprecated 不再使用
 */
export const roleToolsRegistry = new RoleToolsRegistry();
