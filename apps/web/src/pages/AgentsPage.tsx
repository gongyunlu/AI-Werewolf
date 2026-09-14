import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './AgentsPage.module.css';
import { apiClient } from '@/lib/api-client';
import type { Agent } from '@/lib/api-client';
import { getAdminToken, setAdminToken } from '@/lib/admin-token';
import { AppHeader } from '@/components/AppHeader';
import { AgentEditDialog } from '@/components/AgentEditDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const ALL_TAGS = '__all__';

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tagFilter, setTagFilter] = useState(ALL_TAGS);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [token, setToken] = useState(getAdminToken);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiClient
      .getAgents(showInactive)
      .then((loaded) => {
        if (!cancelled) setAgents(loaded);
        return undefined;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载 Agent 失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showInactive]);

  // 标签只是识别与筛选用的自由文本，这里直接按出现过的值生成筛选项与候选项
  const tags = useMemo(
    () => [...new Set(agents.map((agent) => agent.tag).filter((tag): tag is string => !!tag))],
    [agents],
  );
  const visibleAgents = useMemo(
    () => (tagFilter === ALL_TAGS ? agents : agents.filter((agent) => agent.tag === tagFilter)),
    [agents, tagFilter],
  );

  const handleTokenSave = useCallback(() => {
    setAdminToken(token);
    setError('');
  }, [token]);

  const handleAgentSaved = useCallback((saved: Agent) => {
    setAgents((prev) => prev.map((agent) => (agent.id === saved.id ? saved : agent)));
    // 弹窗还开着，同步换成新对象，密钥掩码、标签这些字段才会跟着刷新
    setEditing((prev) => (prev?.id === saved.id ? saved : prev));
  }, []);

  /** 软删除：停用后不再被开局选中，历史对局的玩家外键与复盘不受影响。 */
  const handleToggleActive = useCallback(async (agent: Agent) => {
    try {
      const saved = await apiClient.updateAgent(agent.id, { isActive: !agent.isActive });
      setAgents((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
      setError('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '操作失败，请重试');
    }
  }, []);

  return (
    <div className={styles.page}>
      <AppHeader />
      <div className={styles.body}>
        <div className={styles.container}>
          <div className={styles.head}>
            <h1 className={styles.heading}>Agent 管理</h1>
            <div className={styles.tokenRow}>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="管理令牌（x-admin-token）"
                className={styles.tokenInput}
                autoComplete="off"
              />
              <Button size="sm" variant="outline" onClick={handleTokenSave}>
                保存令牌
              </Button>
              <span className={styles.tokenHint}>只存在本机浏览器，写接口才需要</span>
            </div>
          </div>

          <div className={styles.toolbar}>
            <label htmlFor="agent-tag-filter" className={styles.toolbarLabel}>
              按标签筛选
            </label>
            <select
              id="agent-tag-filter"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className={styles.select}
            >
              <option value={ALL_TAGS}>全部标签</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <label className={styles.toolbarCheckbox}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              显示已停用
            </label>
            <span className={styles.count}>共 {visibleAgents.length} 个 Agent</span>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.tableWrapper}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead>默认模型</TableHead>
                  <TableHead>接入端点</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>记忆集</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className={styles.actionHead}>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAgents.map((agent) => (
                  <TableRow
                    key={agent.id}
                    className={agent.isActive ? undefined : styles.rowInactive}
                  >
                    <TableCell className={styles.nameCell}>
                      <span className={styles.agentName}>{agent.name}</span>
                      {agent.notes && (
                        <span className={styles.notes} title={agent.notes}>
                          {agent.notes}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {agent.tag ? (
                        <Badge variant="secondary">{agent.tag}</Badge>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </TableCell>
                    <TableCell className={styles.mono}>{agent.defaultModelName}</TableCell>
                    <TableCell className={styles.mono}>
                      {agent.baseUrl ?? <span className={styles.muted}>环境变量默认接入</span>}
                    </TableCell>
                    <TableCell className={styles.mono}>
                      {agent.hasApiKey ? (
                        agent.apiKeyMasked
                      ) : (
                        <span className={styles.muted}>未配置</span>
                      )}
                    </TableCell>
                    <TableCell>{agent.memoryLabel}</TableCell>
                    <TableCell>
                      {agent.isActive ? (
                        <Badge variant="outline" className={styles.badgeActive}>
                          活跃
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className={styles.badgeInactive}>
                          已停用
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className={styles.actions}>
                        <Button size="sm" variant="outline" onClick={() => setEditing(agent)}>
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className={agent.isActive ? styles.stopButton : styles.startButton}
                          onClick={() => void handleToggleActive(agent)}
                        >
                          {agent.isActive ? '停用' : '启用'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && visibleAgents.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className={styles.empty}>
                      该标签下没有 Agent
                    </TableCell>
                  </TableRow>
                )}
                {loading && (
                  <TableRow>
                    <TableCell colSpan={8} className={styles.empty}>
                      加载中…
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {editing && (
        <AgentEditDialog
          agent={editing}
          tagOptions={tags}
          onOpenChange={() => setEditing(null)}
          onSaved={handleAgentSaved}
        />
      )}
    </div>
  );
}
