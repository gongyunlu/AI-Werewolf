import { useCallback, useEffect, useState } from 'react';
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
    <label
      htmlFor={`agent-${agent.id}`}
      className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 hover:bg-slate-700 transition-colors"
    >
      <input
        id={`agent-${agent.id}`}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className="accent-cyan-500 cursor-pointer"
      />
      <span className="text-sm flex-1">{agent.name}</span>
      <span className="text-xs text-slate-500">{agent.defaultModelName}</span>
    </label>
  );
}

interface Props {
  onCreated: () => void;
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
      await apiClient.createGame({ rulesetId, agentIds: selectedAgentIds });
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [rulesetId, requiredCount, selectedAgentIds, onCreated]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="cursor-pointer bg-cyan-600 hover:bg-cyan-500 text-white">
          创建对局
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-slate-100 text-lg">创建新对局</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* 规则集 */}
          <div className="space-y-1.5">
            <label htmlFor="ruleset-select" className="text-sm text-slate-400">
              规则集
            </label>
            <select
              id="ruleset-select"
              value={rulesetId}
              onChange={handleRulesetChange}
              className="w-full cursor-pointer rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              {rulesets.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（{r.playerCount} 人）
                </option>
              ))}
            </select>
          </div>

          {/* Agent 列表 */}
          <div className="space-y-1.5">
            <p className="text-sm text-slate-400">
              选择 Agent
              {requiredCount > 0 && (
                <span className="ml-2 text-slate-500">
                  需要 {requiredCount} 个，已选{' '}
                  <span
                    className={
                      selectedAgentIds.length === requiredCount ? 'text-cyan-400' : 'text-slate-300'
                    }
                  >
                    {selectedAgentIds.length}
                  </span>
                </span>
              )}
            </p>
            <ScrollArea className="h-52 rounded border border-slate-700 bg-slate-800">
              <div className="p-2 space-y-0.5">
                {agents.map((agent) => (
                  <AgentCheckbox
                    key={agent.id}
                    agent={agent}
                    checked={selectedAgentIds.includes(agent.id)}
                    onToggle={toggleAgent}
                  />
                ))}
                {agents.length === 0 && (
                  <p className="text-sm text-slate-500 px-3 py-4 text-center">暂无可用 Agent</p>
                )}
              </div>
            </ScrollArea>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={handleClose}
              className="cursor-pointer border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
            >
              取消
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={loading}
              className="cursor-pointer bg-cyan-600 hover:bg-cyan-500 text-white disabled:cursor-not-allowed"
            >
              {loading ? '创建中...' : '创建对局'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
