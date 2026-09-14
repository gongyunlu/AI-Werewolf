import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AgentEditDialog } from './AgentEditDialog';
import type { Agent } from '@/lib/api-client';

const api = vi.hoisted(() => ({
  updateAgent: vi.fn(),
  getPersonaStrategy: vi.fn(),
  replacePersonaStrategy: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

const agent: Agent = {
  id: 'a',
  name: '甲',
  defaultModelName: 'deepseek-chat',
  memoryLabel: '张三',
  isActive: true,
  baseUrl: null,
  hasApiKey: false,
  apiKeyMasked: null,
  tag: '火山方舟',
  notes: null,
};

const renderDialog = (onSaved = vi.fn(), onOpenChange = vi.fn()) => ({
  onSaved,
  onOpenChange,
  ...render(
    <AgentEditDialog
      agent={agent}
      tagOptions={['火山方舟', 'DS官方']}
      onSaved={onSaved}
      onOpenChange={onOpenChange}
    />,
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getPersonaStrategy.mockResolvedValue({
    label: '张三',
    persona: [{ id: 'p1', title: '沉稳', content: '少说多听', importance: 1 }],
    strategy: [],
  });
  api.replacePersonaStrategy.mockResolvedValue({ label: '张三', persona: [], strategy: [] });
});

it('接入配置页签保存只提交接入字段，不碰人设接口', async () => {
  api.updateAgent.mockResolvedValue({ ...agent, defaultModelName: 'deepseek-v4-pro' });
  const { onOpenChange } = renderDialog();

  fireEvent.change(screen.getByLabelText('默认模型'), { target: { value: 'deepseek-v4-pro' } });
  fireEvent.click(screen.getByRole('button', { name: '保存接入配置' }));

  await waitFor(() =>
    expect(api.updateAgent).toHaveBeenCalledWith('a', { defaultModelName: 'deepseek-v4-pro' }),
  );
  expect(api.replacePersonaStrategy).not.toHaveBeenCalled();
  expect(api.getPersonaStrategy).not.toHaveBeenCalled();
  // 保存后留在弹窗里继续改，页签两侧行为一致
  expect(onOpenChange).not.toHaveBeenCalled();
});

it('人设页签保存只提交人设，不碰接入配置接口', async () => {
  renderDialog();

  fireEvent.click(screen.getByRole('tab', { name: '人设与策略' }));
  await screen.findByDisplayValue('沉稳');
  fireEvent.click(screen.getByRole('button', { name: '保存人设与策略' }));

  await waitFor(() =>
    expect(api.replacePersonaStrategy).toHaveBeenCalledWith(
      'a',
      { persona: [{ title: '沉稳', content: '少说多听' }], strategy: [] },
      '张三',
    ),
  );
  expect(api.updateAgent).not.toHaveBeenCalled();
});

it('标签输入既可下拉选择也可输入新值', () => {
  renderDialog();

  const input = screen.getByLabelText('标签') as HTMLInputElement;
  const list = document.getElementById(input.getAttribute('list')!) as HTMLDataListElement;

  expect([...list.options].map((option) => option.value)).toEqual(['火山方舟', 'DS官方']);

  fireEvent.change(input, { target: { value: '中转站A' } });
  expect(input.value).toBe('中转站A');
});
