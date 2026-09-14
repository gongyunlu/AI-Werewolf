import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import GamesListPage from './GamesListPage';
import type { GameListItem } from '@/types/game';

const api = vi.hoisted(() => ({
  getGames: vi.fn(),
  recoverGame: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: api }));

const game = (overrides: Partial<GameListItem>): GameListItem => ({
  id: 'g1',
  status: 'pending_recovery',
  rulesetId: 'standard6p',
  startedAt: '2026-09-13T10:00:00.000Z',
  endedAt: null,
  winnerFaction: null,
  totalDays: 1,
  ruleset: { id: 'standard6p', name: '标准六人局' },
  players: [],
  ...overrides,
});

const listResponse = (items: GameListItem[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
  totalPages: 1,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <GamesListPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

it('待恢复的对局可以就地恢复，成功后按最新状态刷新列表', async () => {
  api.getGames
    .mockResolvedValueOnce(listResponse([game({})]))
    .mockResolvedValueOnce(listResponse([game({ status: 'running' })]));
  api.recoverGame.mockResolvedValue(undefined);
  renderPage();

  fireEvent.click(await screen.findByRole('button', { name: '恢复' }));

  await waitFor(() => expect(api.recoverGame).toHaveBeenCalledWith('g1'));
  expect(await screen.findByText('进行中')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument();
});

it('恢复被拒时显示后端给出的原因', async () => {
  api.getGames.mockResolvedValue(listResponse([game({})]));
  api.recoverGame.mockRejectedValue(
    new Error('运行代码、规则或模型配置已变化，请使用创建检查点时的版本恢复'),
  );
  renderPage();

  fireEvent.click(await screen.findByRole('button', { name: '恢复' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    '运行代码、规则或模型配置已变化，请使用创建检查点时的版本恢复',
  );
});
