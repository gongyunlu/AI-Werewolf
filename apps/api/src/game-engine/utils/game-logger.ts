import { Logger } from '@nestjs/common';

/**
 * 游戏引擎统一日志实例
 *
 * 日志级别约定：
 * - ERROR: Agent 执行失败、系统异常
 * - WARN: 降级策略、异常但可恢复的情况
 * - INFO: 关键业务节点（游戏开始/结束、阶段切换、玩家死亡）
 * - DEBUG: 详细执行流程、Agent 决策过程
 */
export const gameLogger = new Logger('GameEngine');
