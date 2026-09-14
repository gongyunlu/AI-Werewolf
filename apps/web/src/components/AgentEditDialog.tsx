import { useCallback, useEffect, useId, useState } from 'react';
import styles from './AgentEditDialog.module.css';
import { apiClient } from '@/lib/api-client';
import type { Agent } from '@/lib/api-client';
import { buildAccessPatch } from '@/lib/agent-access';
import { PersonaStrategyPanel } from '@/components/PersonaStrategyPanel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Props {
  agent: Agent;
  /** 现有 Agent 上用过的标签，作为可选项；仍可自由输入新值 */
  tagOptions: string[];
  onOpenChange: (open: boolean) => void;
  onSaved: (agent: Agent) => void;
}

export function AgentEditDialog({ agent, tagOptions, onOpenChange, onSaved }: Props) {
  const baseUrlId = useId();
  const apiKeyId = useId();
  const tagId = useId();
  const tagListId = useId();
  const modelId = useId();
  const notesId = useId();

  const [baseUrl, setBaseUrl] = useState(agent.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [tag, setTag] = useState(agent.tag ?? '');
  const [modelName, setModelName] = useState(agent.defaultModelName);
  const [notes, setNotes] = useState(agent.notes ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseUrl(agent.baseUrl ?? '');
    setApiKey('');
    setTag(agent.tag ?? '');
    setModelName(agent.defaultModelName);
    setNotes(agent.notes ?? '');
    setError('');
  }, [agent]);

  const handleSave = useCallback(async () => {
    setError('');
    try {
      const access = buildAccessPatch(agent, { baseUrl, apiKey });
      const patch = {
        ...access,
        ...(modelName.trim() && modelName.trim() !== agent.defaultModelName
          ? { defaultModelName: modelName.trim() }
          : {}),
        ...(tag.trim() !== (agent.tag ?? '') ? { tag: tag.trim() || null } : {}),
        ...(notes.trim() !== (agent.notes ?? '') ? { notes: notes.trim() } : {}),
      };
      if (Object.keys(patch).length === 0) {
        onOpenChange(false);
        return;
      }
      setSaving(true);
      // 保存后留在弹窗里：父组件会把新的 Agent 传回来，字段随之刷新
      onSaved(await apiClient.updateAgent(agent.id, patch));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [agent, baseUrl, apiKey, tag, modelName, notes, onSaved, onOpenChange]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>编辑 {agent.name}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="access" className={styles.tabs}>
          <TabsList>
            <TabsTrigger value="access">接入配置</TabsTrigger>
            <TabsTrigger value="persona">人设与策略</TabsTrigger>
          </TabsList>

          <TabsContent value="access" className={styles.tabPanel}>
            <div className={styles.field}>
              <label htmlFor={modelId} className={styles.label}>
                默认模型
              </label>
              <input
                id={modelId}
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className={styles.input}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor={tagId} className={styles.label}>
                标签
              </label>
              <input
                id={tagId}
                list={tagListId}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="从已有标签中选，或直接输入新标签"
                className={styles.input}
              />
              <datalist id={tagListId}>
                {tagOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </datalist>
              <p className={styles.hint}>只用于识别与筛选，不参与模型路由。</p>
            </div>

            <div className={styles.field}>
              <label htmlFor={baseUrlId} className={styles.label}>
                接入端点
              </label>
              <input
                id={baseUrlId}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="留空则使用服务端环境变量里的默认接入"
                className={styles.input}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor={apiKeyId} className={styles.label}>
                密钥
              </label>
              <input
                id={apiKeyId}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  agent.hasApiKey ? `已配置 ${agent.apiKeyMasked}，留空表示不修改` : '尚未配置'
                }
                autoComplete="new-password"
                className={styles.input}
              />
              <p className={styles.hint}>密钥只写不读，保存后只显示末四位掩码。</p>
            </div>

            <div className={styles.field}>
              <label htmlFor={notesId} className={styles.label}>
                备注
              </label>
              <textarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className={styles.textarea}
              />
            </div>

            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.actions}>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : '保存接入配置'}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="persona" className={styles.tabPanel}>
            <PersonaStrategyPanel agent={agent} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
