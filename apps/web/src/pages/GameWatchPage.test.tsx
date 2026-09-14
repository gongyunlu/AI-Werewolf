import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import GameWatchPage from './GameWatchPage';
import { currentTheme, applyStoredTheme } from '@/lib/theme';

vi.mock('@/hooks/useGameStream', () => ({ useGameStream: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    getGame: vi.fn().mockResolvedValue({
      id: 'g1',
      status: 'initialized',
      ruleset: { name: '标准六人局' },
      players: [1, 2].map((seatNo) => ({
        id: `p${seatNo}`,
        seatNo,
        displayName: `玩家${seatNo}`,
        modelName: 'deepseek-flash',
        role: 'villager',
        faction: 'villager',
        deathDay: seatNo === 2 ? 1 : null,
        deathCause: null,
      })),
    }),
  },
}));

afterEach(() => {
  document.documentElement.classList.remove('day');
  localStorage.clear();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

it('观战页提供持久化昼夜切换，同时保留两侧玩家和出局信息', async () => {
  Element.prototype.scrollIntoView = vi.fn();
  document.documentElement.classList.remove('day');
  render(
    <MemoryRouter initialEntries={['/games/g1']}>
      <Routes>
        <Route path="/games/:id" element={<GameWatchPage />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByRole('heading', { name: '标准六人局' })).toBeInTheDocument();
  expect(
    within(screen.getByRole('complementary', { name: '左侧玩家' })).getByText('玩家1'),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole('complementary', { name: '右侧玩家' })).getByText('已出局 · 第 1 天'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '切换到白天主题' }));
  expect(currentTheme()).toBe('day');
  document.documentElement.classList.remove('day');
  applyStoredTheme();
  expect(currentTheme()).toBe('day');
  fireEvent.click(screen.getByRole('button', { name: '切换到夜晚主题' }));
  expect(currentTheme()).toBe('night');
});
