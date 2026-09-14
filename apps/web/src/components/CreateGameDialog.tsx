import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import styles from './CreateGameDialog.module.css';
import { apiClient } from '@/lib/api-client';
import type { Ruleset, Agent } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

/** 标签筛选的「不筛选」取值，与真实标签值区分开 */
const ALL_TAGS = '__all__';

interface AgentCheckboxProps {
  agent: Agent;
  checked: boolean;
  onToggle: (id: string) => void;
}

function AgentCheckbox({ agent, checked, onToggle }: AgentCheckboxProps) {
  const id = useId();
  const handleChange = useCallback(() => onToggle(agent.id), [agent.id, onToggle]);
  return (
    <label htmlFor={id} className={styles.agentCheckbox}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className={styles.checkbox}
      />
      <span className={styles.agentName}>{agent.name}</span>
      {agent.tag && <span className={styles.agentTag}>{agent.tag}</span>}
      <span className={styles.agentModel}>{agent.defaultModelName}</span>
    </label>
  );
}

interface Props {
  onCreated: (gameId: string) => void;
  mode?: 'normal' | 'ab';
}

export function CreateGameDialog({ onCreated, mode = 'normal' }: Props) {
  const selectId = useId();
  const tagSelectId = useId();
  const [open, setOpen] = useState(false);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rulesetId, setRulesetId] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState(ALL_TAGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedAgentIds([]);
    setTagFilter(ALL_TAGS);
    Promise.all([apiClient.getRulesets(), apiClient.getAgents()])
      .then(([rs, ag]) => {
        setRulesets(rs);
        setAgents(ag);
        if (rs.length > 0) setRulesetId(rs[0].id);
        return undefined;
      })
      .catch(() => setError('加载数据失败，请检查后端连接'));
  }, [open]);

  const toggleAgent = useCallback((id: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const requiredCount = rulesets.find((r) => r.id === rulesetId)?.playerCount ?? 0;

  // 标签只用于缩小选择范围，已勾选但被筛掉的 Agent 仍保留在选择结果里
  const tags = useMemo(
    () => [...new Set(agents.map((a) => a.tag).filter((tag): tag is string => !!tag))],
    [agents],
  );
  const visibleAgents = useMemo(
    () => (tagFilter === ALL_TAGS ? agents : agents.filter((a) => a.tag === tagFilter)),
    [agents, tagFilter],
  );

  const handleRulesetChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setRulesetId(e.target.value);
  }, []);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleSubmit = useCallback(async () => {
    setError('');
    if (!rulesetId) {
      setError('请选择规则集');
      return;
    }
    if (requiredCount > 0 && selectedAgentIds.length !== requiredCount) {
      setError(
        `该规则集需要恰好 ${requiredCount} 个 Agent，当前已选 ${selectedAgentIds.length} 个`,
      );
      return;
    }
    try {
      setLoading(true);
      const dto = { rulesetId, agentIds: selectedAgentIds };
      const gameId =
        mode === 'ab'
          ? (await apiClient.startAbGames(dto)).gameIds[0]
          : (await apiClient.createGame(dto)).id;
      setOpen(false);
      onCreated(gameId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [rulesetId, requiredCount, selectedAgentIds, onCreated, mode]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className={styles.createButton}>
          {mode === 'ab' ? '开始 A/B 对局' : '创建对局'}
        </Button>
      </DialogTrigger>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>
            {mode === 'ab' ? '开始 A/B 对局' : '创建新对局'}
          </DialogTitle>
        </DialogHeader>

        <div className={styles.body}>
          {mode === 'ab' && (
            <p>
              将启动 1 对、共 2 局 ON/OFF；两局使用相同
              Agent、模型、角色与座次。赛后自动评分，反思可手动运行且不写回经验。
            </p>
          )}
          {/* 规则集 */}
          <div className={styles.section}>
            <label htmlFor={selectId} className={styles.sectionLabel}>
              规则集
            </label>
            <select
              id={selectId}
              value={rulesetId}
              onChange={handleRulesetChange}
              className={styles.select}
            >
              {rulesets.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（{r.playerCount} 人）
                </option>
              ))}
            </select>
          </div>

          {/* Agent 列表 */}
          <div className={styles.section}>
            <p className={styles.sectionLabel}>
              选择 Agent
              {requiredCount > 0 && (
                <span className={styles.countText}>
                  需要 {requiredCount} 个，已选{' '}
                  <span
                    className={
                      selectedAgentIds.length === requiredCount
                        ? styles.countValueMet
                        : styles.countValueNotMet
                    }
                  >
                    {selectedAgentIds.length}
                  </span>
                </span>
              )}
            </p>
            {tags.length > 0 && (
              <div className={styles.tagFilter}>
                <label htmlFor={tagSelectId} className={styles.tagFilterLabel}>
                  标签
                </label>
                <select
                  id={tagSelectId}
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  className={styles.select}
                >
                  <option value={ALL_TAGS}>全部</option>
                  {tags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <ScrollArea className={styles.scrollArea}>
              <div className={styles.scrollInner}>
                {visibleAgents.map((agent) => (
                  <AgentCheckbox
                    key={agent.id}
                    agent={agent}
                    checked={selectedAgentIds.includes(agent.id)}
                    onToggle={toggleAgent}
                  />
                ))}
                {visibleAgents.length === 0 && (
                  <p className={styles.emptyAgents}>
                    {agents.length === 0 ? '暂无可用 Agent' : '该标签下没有 Agent'}
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <Button variant="outline" onClick={handleClose} className={styles.cancelButton}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading} className={styles.createButton}>
              {loading ? '创建中...' : mode === 'ab' ? '启动 2 局' : '创建对局'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
