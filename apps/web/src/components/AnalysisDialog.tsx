import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './AnalysisDialog.module.css';
import { apiClient, type AnalysisStatus } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  gameId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** 赛后分析：展示进度并按需重跑评分或反思 */
export function AnalysisDialog({ gameId, onOpenChange }: Props) {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async (id: string) => {
    const requestId = ++refreshRequestId.current;
    try {
      const nextStatus = await apiClient.getAnalysisStatus(id);
      if (requestId === refreshRequestId.current) {
        setStatus(nextStatus);
        setError('');
      }
    } catch (e: unknown) {
      if (requestId === refreshRequestId.current) {
        setError(e instanceof Error ? e.message : '加载分析进度失败');
      }
    }
  }, []);

  useEffect(() => {
    if (!gameId) {
      // 关闭弹窗时让尚未完成的请求失效，避免旧对局响应回写到下一次打开。
      refreshRequestId.current += 1;
      setStatus(null);
      return;
    }
    setError('');
    setNotice('');
    setStatus(null);
    void refresh(gameId);
  }, [gameId, refresh]);

  const run = useCallback(
    async (options: { judge: boolean; reflect: boolean; force?: boolean }) => {
      if (!gameId) return;
      setError('');
      setNotice('');
      try {
        setLoading(true);
        const result = await apiClient.analyzeGame(gameId, options);
        // analysis-status 只有持久化汇总，没有当前 run 标识。投递后不能立即用旧汇总冒充新任务进度。
        refreshRequestId.current += 1;
        setStatus(null);
        if (result.skipped) {
          setNotice('已有分析正在运行或已完成，未重新投递。可刷新进度查看当前状态。');
        } else {
          setNotice(
            `已投递：评分 ${result.judged} 项、反思 ${result.reflectPlanned} 人。请稍后刷新查看完成情况。`,
          );
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '投递失败，请重试');
      } finally {
        setLoading(false);
      }
    },
    [gameId],
  );

  const runAll = useCallback(() => run({ judge: true, reflect: true, force: true }), [run]);
  const runJudgeOnly = useCallback(() => run({ judge: true, reflect: false, force: true }), [run]);
  const runReflectOnly = useCallback(
    () => run({ judge: false, reflect: true, force: true }),
    [run],
  );
  const handleRefresh = useCallback(() => {
    if (gameId) void refresh(gameId);
  }, [gameId, refresh]);

  return (
    <Dialog open={!!gameId} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>赛后分析</DialogTitle>
        </DialogHeader>

        <div className={styles.body}>
          <div className={styles.statusList}>
            <div className={styles.statusRow}>
              <span className={styles.statusLabel}>决策与发言评分</span>
              <span className={styles.statusValue}>
                {status ? `${status.judgedCount} / ${status.judgeableCount}` : '—'}
              </span>
            </div>
            <div className={styles.statusRow}>
              <span className={styles.statusLabel}>玩家反思</span>
              <span className={styles.statusValue}>
                {status ? `${status.reflectedCount} / ${status.playerCount}` : '—'}
              </span>
            </div>
            <div className={styles.statusRow}>
              <span className={styles.statusLabel}>对局复盘</span>
              <span
                className={
                  status?.narrativeReady
                    ? `${styles.statusValue} ${styles.statusValueReady}`
                    : styles.statusValue
                }
              >
                {status ? (status.narrativeReady ? '已生成' : '未生成') : '—'}
              </span>
            </div>
          </div>

          <p className={styles.hint}>
            开始分析会强制全量重跑评分与反思。重跑评分只重新打分决策与发言（复用已有反思）；
            重跑反思只重新复盘与玩家反思（复用已有评分），并会把本局此前产出的记忆标记为失效。
          </p>

          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {notice && (
            <p role="alert" className={styles.notice}>
              {notice}
            </p>
          )}

          <div className={styles.actions}>
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={loading}
              className={styles.secondaryButton}
            >
              刷新进度
            </Button>
            <Button
              variant="outline"
              onClick={runJudgeOnly}
              disabled={loading}
              className={styles.secondaryButton}
            >
              重跑评分
            </Button>
            <Button
              variant="outline"
              onClick={runReflectOnly}
              disabled={loading}
              className={styles.secondaryButton}
            >
              重跑反思
            </Button>
            <Button
              onClick={runAll}
              disabled={loading}
              aria-busy={loading}
              className={styles.primaryButton}
            >
              {loading ? '投递中...' : '开始分析'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
