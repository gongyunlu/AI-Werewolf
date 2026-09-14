import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import AgentsPage from './AgentsPage';
import type { Agent } from '@/lib/api-client';

const api = vi.hoisted(() => ({
  getAgents: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

const agent = (overrides: Partial<Agent>): Agent => ({
  id: 'a',
  name: '甲',
  defaultModelName: 'deepseek-chat',
  memoryLabel: '张三',
  isActive: true,
  baseUrl: null,
  hasApiKey: false,
  apiKeyMasked: null,
  tag: null,
  notes: null,
  ...overrides,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AgentsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.getAgents.mockResolvedValue([
    agent({ id: 'a', name: '甲', tag: '火山方舟' }),
    agent({ id: 'b', name: '乙', tag: 'DS官方' }),
  ]);
});

it('按标签筛选只保留该标签的 Agent', async () => {
  renderPage();
  await screen.findByText('甲');

  fireEvent.change(screen.getByLabelText('按标签筛选'), { target: { value: 'DS官方' } });

  expect(screen.getByText('乙')).toBeInTheDocument();
  expect(screen.queryByText('甲')).not.toBeInTheDocument();
  expect(screen.getByText('共 1 个 Agent')).toBeInTheDocument();
});

it('停用走软删除：只提交 isActive，并把该行切成已停用', async () => {
  api.updateAgent.mockResolvedValue(
    agent({ id: 'a', name: '甲', tag: '火山方舟', isActive: false }),
  );
  renderPage();
  await screen.findByText('甲');

  fireEvent.click(screen.getAllByRole('button', { name: '停用' })[0]);

  await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('a', { isActive: false }));
  expect(await screen.findByRole('button', { name: '启用' })).toBeInTheDocument();
  expect(screen.getByText('已停用')).toBeInTheDocument();
});

it('显示已停用开关决定列表接口是否带上停用的 Agent', async () => {
  renderPage();
  await screen.findByText('甲');
  expect(api.getAgents).toHaveBeenLastCalledWith(false);

  fireEvent.click(screen.getByLabelText('显示已停用'));

  await waitFor(() => expect(api.getAgents).toHaveBeenLastCalledWith(true));
});
