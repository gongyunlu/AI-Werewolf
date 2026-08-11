import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolContext } from './tool-context';

/**
 * 角色工具构建器
 *
 * 根据上下文构建该角色的工具列表
 */
export type RoleToolBuilder = (ctx: ToolContext) => StructuredToolInterface[];

/**
 * 角色工具注册表
 *
 * 负责管理角色 → 工具的映射关系，支持动态注册新角色
 *
 * 设计理念：
 * - 新增角色只需调用 register()，无需修改工厂代码
 * - 支持角色不存在时返回默认工具（skip_action）
 * - 所有角色工具在模块加载时自动注册
 */
class RoleToolsRegistry {
  private builders = new Map<string, RoleToolBuilder>();

  /**
   * 注册角色工具构建器
   *
   * @param role 角色名称（与 GameState.players[].role 一致）
   * @param builder 工具构建器函数
   */
  register(role: string, builder: RoleToolBuilder): void {
    if (this.builders.has(role)) {
      throw new Error(`角色工具构建器已存在: ${role}`);
    }
    this.builders.set(role, builder);
  }

  /**
   * 获取角色的工具列表
   *
   * @param role 角色名称
   * @param ctx 工具上下文
   * @returns 工具列表（如果角色未注册，返回空数组）
   */
  getTools(role: string, ctx: ToolContext): StructuredToolInterface[] {
    const builder = this.builders.get(role);
    if (!builder) {
      return []; // 未注册角色返回空工具列表
    }
    const tools = builder(ctx);
    return tools;
  }

  /**
   * 检查角色是否已注册
   */
  hasRole(role: string): boolean {
    return this.builders.has(role);
  }

  /**
   * 获取所有已注册的角色列表
   */
  getRegisteredRoles(): string[] {
    return Array.from(this.builders.keys());
  }
}

/**
 * 全局角色工具注册表实例
 */
export const roleToolsRegistry = new RoleToolsRegistry();
