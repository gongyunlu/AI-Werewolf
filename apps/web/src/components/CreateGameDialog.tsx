import { useCallback, useEffect, useState } from 'react';
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

interface AgentCheckboxProps {
  agent: Agent;
  checked: boolean;
  onToggle: (id: string) => void;
}

function AgentCheckbox({ agent, checked, onToggle }: AgentCheckboxProps) {
  const handleChange = useCallback(() => onToggle(agent.id), [agent.id, onToggle]);
  return (
    <label htmlFor={`agent-${agent.id}`} className={styles.agentCheckbox}>
      <input
        id={`agent-${agent.id}`}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className={styles.checkbox}
      />
      <span className={styles.agentName}>{agent.name}</span>
      <span className={styles.agentModel}>{agent.defaultModelName}</span>
    </label>
  );
}

interface Props {
  onCreated: (gameId: string) => void;
}

export function CreateGameDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rulesetId, setRulesetId] = useState('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedAgentIds([]);
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
      const result = await apiClient.createGame({ rulesetId, agentIds: selectedAgentIds });
      setOpen(false);
      onCreated(result.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [rulesetId, requiredCount, selectedAgentIds, onCreated]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className={styles.createButton}>创建对局</Button>
      </DialogTrigger>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>创建新对局</DialogTitle>
        </DialogHeader>

        <div className={styles.body}>
          {/* 规则集 */}
          <div className={styles.section}>
            <label htmlFor="ruleset-select" className={styles.sectionLabel}>
              规则集
            </label>
            <select
              id="ruleset-select"
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
            <ScrollArea className={styles.scrollArea}>
              <div className={styles.scrollInner}>
                {agents.map((agent) => (
                  <AgentCheckbox
                    key={agent.id}
                    agent={agent}
                    checked={selectedAgentIds.includes(agent.id)}
                    onToggle={toggleAgent}
                  />
                ))}
                {agents.length === 0 && <p className={styles.emptyAgents}>暂无可用 Agent</p>}
              </div>
            </ScrollArea>
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.actions}>
            <Button variant="outline" onClick={handleClose} className={styles.cancelButton}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading} className={styles.createButton}>
              {loading ? '创建中...' : '创建对局'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
