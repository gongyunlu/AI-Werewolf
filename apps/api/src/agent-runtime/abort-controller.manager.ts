import { Injectable, Logger } from '@nestjs/common';

/**
 * 集中管理游戏执行过程中的 AbortController
 *
 * 职责：
 * - 为每个 gameId 维护 AbortController 列表
 * - 当连接断开时，立即中断该游戏的所有 LLM 调用
 * - 自动清理已完成的 controller
 */
@Injectable()
export class AbortControllerManager {
  private readonly logger = new Logger(AbortControllerManager.name);

  // gameId -> AbortController[]
  private readonly controllers = new Map<string, Set<AbortController>>();

  /**
   * 为指定游戏注册一个 AbortController
   * 返回该 controller，调用方需要在完成后调用 unregister
   */
  register(gameId: string): AbortController {
    const controller = new AbortController();

    if (!this.controllers.has(gameId)) {
      this.controllers.set(gameId, new Set());
    }

    this.controllers.get(gameId)!.add(controller);

    return controller;
  }

  /**
   * 注销已完成的 AbortController
   */
  unregister(gameId: string, controller: AbortController): void {
    const controllers = this.controllers.get(gameId);
    if (controllers) {
      controllers.delete(controller);

      if (controllers.size === 0) {
        this.controllers.delete(gameId);
      }
    }
  }

  /**
   * 中断指定游戏的所有 LLM 调用（由 broadcaster 在连接断开时调用）
   */
  abortGame(gameId: string, reason = 'SSE connection closed'): void {
    const controllers = this.controllers.get(gameId);

    if (!controllers || controllers.size === 0) {
      return;
    }

    this.logger.log(`中断游戏 ${gameId} 的 ${controllers.size} 个 LLM 调用，原因: ${reason}`);

    controllers.forEach((controller) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    });

    // 中断后清空
    this.controllers.delete(gameId);
  }

  /**
   * 获取指定游戏当前活跃的 controller 数量（用于监控）
   */
  getActiveCount(gameId: string): number {
    return this.controllers.get(gameId)?.size ?? 0;
  }
}
