/**
 * 对局的 FINISHED 终局事实已经持久化，只有赛后结算/分析投递仍需完成。
 *
 * 包括引擎已正常返回后的分析失败，以及终局事务提交后客户端响应不确定、
 * Worker 重新读取到 FINISHED 的恢复场景。下一 attempt 只补分析，不重放引擎。
 */
export class PostGameAnalysisError extends Error {
  readonly originalError: unknown;

  constructor(gameId: string, cause: unknown) {
    super(
      `对局 ${gameId} 已结束，仅需补投赛后分析：${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PostGameAnalysisError';
    this.originalError = cause;
  }
}
