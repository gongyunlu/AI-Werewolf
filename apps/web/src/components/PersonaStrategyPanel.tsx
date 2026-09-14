import { useCallback, useEffect, useState } from 'react';
import styles from './PersonaStrategyPanel.module.css';
import { apiClient } from '@/lib/api-client';
import type { Agent, PersonaStrategyItem, PersonaStrategyView } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

/** 与后端一致的注入窗口上限：超出部分存得下但进不了上下文，因此在保存前拦下 */
const INJECTION_LIMIT = 20;

type Kind = 'persona' | 'strategy';

/** 编辑中的条目：key 只用于列表渲染，改动标题不会让输入框失去焦点 */
type DraftItem = PersonaStrategyItem & { key: string };

const toDrafts = (items: PersonaStrategyItem[]): DraftItem[] =>
  items.map(({ title, content }) => ({ key: crypto.randomUUID(), title, content }));

const SECTIONS: Array<{ kind: Kind; title: string; hint: string }> = [
  { kind: 'persona', title: '人设', hint: '表达风格、思维习惯、情绪特征等长期稳定的特质' },
  { kind: 'strategy', title: '策略', hint: '战术倾向，具体动作仍由角色与场况推理产出' },
];

interface Props {
  agent: Agent;
  onSaved?: () => void;
}

export function PersonaStrategyPanel({ agent, onSaved }: Props) {
  const [view, setView] = useState<PersonaStrategyView | null>(null);
  const [items, setItems] = useState<Record<Kind, DraftItem[]>>({
    persona: [],
    strategy: [],
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getPersonaStrategy(agent.id)
      .then((loaded) => {
        if (cancelled) return;
        setView(loaded);
        setItems({
          persona: toDrafts(loaded.persona),
          strategy: toDrafts(loaded.strategy),
        });
        return undefined;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载人设失败');
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const update = useCallback((kind: Kind, index: number, patch: Partial<PersonaStrategyItem>) => {
    setItems((prev) => ({
      ...prev,
      [kind]: prev[kind].map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  }, []);

  const add = useCallback((kind: Kind) => {
    setItems((prev) => ({
      ...prev,
      [kind]: [...prev[kind], { key: crypto.randomUUID(), title: '', content: '' }],
    }));
  }, []);

  const remove = useCallback((kind: Kind, index: number) => {
    setItems((prev) => ({ ...prev, [kind]: prev[kind].filter((_, i) => i !== index) }));
  }, []);

  const handleSave = useCallback(async () => {
    setError('');
    // key 只是渲染用的本地主键，提交前剥掉，不把前端字段带进接口
    const payload = (drafts: DraftItem[]): PersonaStrategyItem[] =>
      drafts.map(({ title, content }) => ({ title, content }));
    const filled = {
      persona: payload(items.persona.filter((item) => item.title.trim() || item.content.trim())),
      strategy: payload(items.strategy.filter((item) => item.title.trim() || item.content.trim())),
    };
    if (filled.persona.some((i) => !i.title.trim() || !i.content.trim()))
      return setError('人设的标题与正文都不能为空');
    if (filled.strategy.some((i) => !i.title.trim() || !i.content.trim()))
      return setError('策略的标题与正文都不能为空');
    if (filled.persona.length + filled.strategy.length > INJECTION_LIMIT)
      return setError(`人设与策略合计不能超过 ${INJECTION_LIMIT} 条`);

    try {
      setSaving(true);
      const saved = await apiClient.replacePersonaStrategy(agent.id, filled, view?.label);
      setView(saved);
      setItems({ persona: toDrafts(saved.persona), strategy: toDrafts(saved.strategy) });
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [agent.id, items, view, onSaved]);

  return (
    <div className={styles.panel}>
      <p className={styles.label}>记忆集：{view?.label ?? agent.memoryLabel}</p>

      {SECTIONS.map((section) => (
        <div key={section.kind} className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{section.title}</span>
            <span className={styles.sectionHint}>{section.hint}</span>
            <Button size="xs" variant="outline" onClick={() => add(section.kind)}>
              添加
            </Button>
          </div>
          <ScrollArea className={styles.scrollArea}>
            <div className={styles.scrollInner}>
              {items[section.kind].map((item, index) => (
                <div key={item.key} className={styles.item}>
                  <input
                    value={item.title}
                    placeholder="标题"
                    onChange={(e) => update(section.kind, index, { title: e.target.value })}
                    className={styles.titleInput}
                  />
                  <textarea
                    value={item.content}
                    placeholder="正文"
                    rows={3}
                    onChange={(e) => update(section.kind, index, { content: e.target.value })}
                    className={styles.contentInput}
                  />
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => remove(section.kind, index)}
                  >
                    删除
                  </Button>
                </div>
              ))}
              {items[section.kind].length === 0 && (
                <p className={styles.empty}>暂无{section.title}，点「添加」新增一条</p>
              )}
            </div>
          </ScrollArea>
        </div>
      ))}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button onClick={handleSave} disabled={saving || !view}>
          {saving ? '保存中...' : '保存人设与策略'}
        </Button>
      </div>
    </div>
  );
}
