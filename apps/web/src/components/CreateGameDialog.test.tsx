import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CreateGameDialog } from './CreateGameDialog';

const api = vi.hoisted(() => ({
  getRulesets: vi.fn(),
  getAgents: vi.fn(),
  createGame: vi.fn(),
  startAbGames: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.getRulesets.mockResolvedValue([{ id: 'rules', name: '测试板子', playerCount: 2 }]);
  api.getAgents.mockResolvedValue([
    { id: 'a', name: '甲', defaultModelName: 'model', isActive: true },
    { id: 'b', name: '乙', defaultModelName: 'model', isActive: true },
  ]);
  api.createGame.mockResolvedValue({ id: 'normal' });
  api.startAbGames.mockResolvedValue({ gameIds: ['on', 'off'], experimentId: 'experiment' });
});

it.each(['normal', 'ab'] as const)('%s 入口使用所选配置调用对应创建接口', async (mode) => {
  const onCreated = vi.fn();
  render(<CreateGameDialog mode={mode} onCreated={onCreated} />);
  fireEvent.click(
    screen.getByRole('button', { name: mode === 'ab' ? '开始 A/B 对局' : '创建对局' }),
  );
  const boxes = await screen.findAllByRole('checkbox');
  for (const box of boxes) fireEvent.click(box);
  // 普通模式触发按钮被 Dialog 隐藏，只能点击弹窗里的提交按钮。
  fireEvent.click(screen.getByRole('button', { name: mode === 'ab' ? '启动 2 局' : '创建对局' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(mode === 'ab' ? 'on' : 'normal'));
  expect(mode === 'ab' ? api.startAbGames : api.createGame).toHaveBeenCalledWith({
    rulesetId: 'rules',
    agentIds: ['a', 'b'],
  });
  expect(mode === 'ab' ? api.createGame : api.startAbGames).not.toHaveBeenCalled();
});

it('按标签筛选只保留该标签的 Agent，已选中的不因筛选丢失', async () => {
  api.getAgents.mockResolvedValue([
    { id: 'a', name: '甲', defaultModelName: 'model', isActive: true, tag: '火山方舟' },
    { id: 'b', name: '乙', defaultModelName: 'model', isActive: true, tag: 'DS官方' },
  ]);
  const onCreated = vi.fn();
  render(<CreateGameDialog onCreated={onCreated} />);
  fireEvent.click(screen.getByRole('button', { name: '创建对局' }));

  // 先选中被筛掉的那个，再切到只显示另一个的标签
  const boxes = await screen.findAllByRole('checkbox');
  fireEvent.click(boxes[0]);
  fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'DS官方' } });

  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByText('乙')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '创建对局' }));
  await waitFor(() =>
    expect(api.createGame).toHaveBeenCalledWith({
      rulesetId: 'rules',
      agentIds: ['a', 'b'],
    }),
  );
});
