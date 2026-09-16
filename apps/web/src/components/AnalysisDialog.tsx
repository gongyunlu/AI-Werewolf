import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './AnalysisDialog.module.css';
import { apiClient, type AnalysisStatus } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  gameId: string | null;
  experiment?: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 赛后分析：展示进度并按需重跑评分或反思 */
export function AnalysisDialog({ gameId, onOpenChange, experiment = false }: Props) {
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

  const runAll = useCallback(() => run({ judge: true, reflect: true, force: false }), [run]);
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
          <DialogTitle className={styles.dialogTitle}>
            {experiment ? 'A/B 评分与反思' : '赛后分析'}
          </DialogTitle>
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
              <span className={styles.statusLabel}>评分采用</span>
              <span className={styles.statusValue}>
                {status
                  ? status.judgeComplete
                    ? '已采用'
                    : status.judgedCount === status.judgeableCount
                      ? '待采用'
                      : '判分未完成'
                  : '—'}
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

          <p className={styles.hint}>评分进度包含已保存的判分，评分采用完成后才开始复盘与反思。</p>

          <p className={styles.hint}>
            {experiment
              ? '评分包含决策与发言。反思仅生成本局分析，不写回经验、对手建模或全局记忆。两个操作分别执行。'
              : '开始/继续分析会复用已保存的评分，补齐未完成的分析。重跑评分会重新调用裁判；重跑反思会重新生成复盘与玩家反思，并将本局此前产出的记忆标记为失效。'}
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
              {experiment ? 'A/B 评分' : '重跑评分'}
            </Button>
            <Button
              variant="outline"
              onClick={runReflectOnly}
              disabled={loading}
              className={styles.secondaryButton}
            >
              {experiment ? 'A/B 反思' : '重跑反思'}
            </Button>
            {!experiment && (
              <Button
                onClick={runAll}
                disabled={loading}
                aria-busy={loading}
                className={styles.primaryButton}
              >
                {loading ? '投递中...' : '开始/继续分析'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
