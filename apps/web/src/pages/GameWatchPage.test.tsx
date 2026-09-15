import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import GameWatchPage from './GameWatchPage';
import { currentTheme, applyStoredTheme } from '@/lib/theme';
import { apiClient } from '@/lib/api-client';
import { useGameStream } from '@/hooks/useGameStream';
import type { GameListItem } from '@/types/game';

vi.mock('@/hooks/useGameStream', () => ({ useGameStream: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    startGame: vi.fn(),
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
  vi.mocked(apiClient.getGame).mockReset();
  document.documentElement.classList.remove('day');
  localStorage.clear();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/games/g2')}>切换测试对局</button>;
}

function renderGames() {
  Element.prototype.scrollIntoView = vi.fn();
  return render(
    <MemoryRouter initialEntries={['/games/g1']}>
      <Navigation />
      <Routes>
        <Route path="/games/:id" element={<GameWatchPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function game(id: string, status: string): GameListItem {
  return {
    id,
    status,
    ruleset: { id: 'r', name: id + '测试对局' },
    players: [],
  } as unknown as GameListItem;
}

it('切局后旧请求迟到不会覆盖新局或关闭新局快照连接', async () => {
  let old!: (value: GameListItem) => void;
  vi.mocked(apiClient.getGame)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValueOnce(game('g2', 'finished'));
  renderGames();
  fireEvent.click(screen.getByText('切换测试对局'));
  expect(await screen.findByText('g2测试对局')).toBeInTheDocument();
  await act(async () => old(game('g1', 'finished')));
  expect(screen.queryByText('g1测试对局')).not.toBeInTheDocument();
  expect(vi.mocked(useGameStream).mock.calls.at(-1)).toEqual([
    'g2',
    'god',
    expect.any(Function),
    expect.objectContaining({ enabled: true }),
  ]);
});

it('切到未开始对局时清除上一局的历史、胜者和关闭定时器', async () => {
  vi.mocked(apiClient.getGame)
    .mockResolvedValueOnce(game('g1', 'finished'))
    .mockResolvedValueOnce(game('g2', 'created'));
  renderGames();
  await screen.findByText('g1测试对局');
  const onMessage = vi.mocked(useGameStream).mock.calls.at(-1)![2];
  act(() =>
    onMessage({
      type: 'connection.ready',
      gameId: 'g1',
      lastSequence: 0,
      playerDeaths: [],
      gameFinished: { winner: 'villager' },
      snapshot: [
        {
          eventId: 'e1',
          sceneId: 's1',
          sceneType: 'speech',
          visibility: 'public',
          status: 'closed',
          content: '上一局内容',
          thinking: '',
          thinkingDurationMs: 0,
          contentDurationMs: 0,
        },
      ],
    }),
  );
  // 终态回读不会影响本用例的新局响应。
  vi.mocked(apiClient.getGame).mockResolvedValueOnce(game('g2', 'created'));
  fireEvent.click(screen.getByText('切换测试对局'));
  await screen.findByText('g2测试对局');
  expect(screen.queryByText('上一局内容')).not.toBeInTheDocument();
  expect(screen.queryByText('已结束 · villager')).not.toBeInTheDocument();
  expect(screen.getByText('开始对局')).toBeInTheDocument();
});

it('待恢复快照立即反映生命周期状态', async () => {
  vi.mocked(apiClient.getGame).mockResolvedValueOnce(game('g1', 'running'));
  renderGames();
  await screen.findByText('g1测试对局');
  const onMessage = vi.mocked(useGameStream).mock.calls.at(-1)![2];
  act(() =>
    onMessage({
      type: 'connection.ready',
      gameId: 'g1',
      gameStatus: 'pending_recovery',
      lastSequence: 0,
      playerDeaths: [],
      snapshot: [],
    }),
  );
  expect(screen.getByText('等待恢复')).toBeInTheDocument();
  expect(screen.queryByText('观战中')).not.toBeInTheDocument();
});

it('慢于轮询间隔的请求不被后续轮询无限废弃', async () => {
  vi.mocked(apiClient.getGame).mockResolvedValueOnce(game('g1', 'running'));
  vi.useFakeTimers();
  try {
    await act(async () => {
      renderGames();
    });
    let resolve!: (value: GameListItem) => void;
    vi.mocked(apiClient.getGame).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    const count = vi.mocked(apiClient.getGame).mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    await act(async () => resolve(game('g1', 'pending_recovery')));
    expect(vi.mocked(apiClient.getGame)).toHaveBeenCalledTimes(count);
    expect(screen.getByText('等待恢复')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('旧 initialized 快照不会废弃已成功的启动响应', async () => {
  vi.mocked(apiClient.getGame).mockResolvedValueOnce(game('g1', 'initialized'));
  let resolve!: (value: GameListItem) => void;
  vi.mocked(apiClient.startGame).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  renderGames();
  await screen.findByText('g1测试对局');
  fireEvent.click(screen.getByText('开始对局'));
  const onMessage = vi.mocked(useGameStream).mock.calls.at(-1)![2];
  act(() =>
    onMessage({
      type: 'connection.ready',
      gameId: 'g1',
      gameStatus: 'initialized',
      lastSequence: 0,
      playerDeaths: [],
      snapshot: [],
    }),
  );
  await act(async () => resolve(game('g1', 'running')));
  expect(screen.queryByText('开始对局')).not.toBeInTheDocument();
  expect(vi.mocked(useGameStream).mock.calls.at(-1)?.[3]).toMatchObject({ revision: 'running' });
});

it('观战页提供持久化昼夜切换，同时保留两侧玩家和出局信息', async () => {
  vi.mocked(apiClient.getGame).mockResolvedValueOnce({
    ...game('g1', 'initialized'),
    ruleset: { id: 'r', name: '标准六人局' },
    players: [1, 2].map((seatNo) => ({
      id: `p${seatNo}`,
      seatNo,
      displayName: `玩家${seatNo}`,
      modelName: 'mock',
      role: 'villager',
      faction: 'villager',
      deathDay: seatNo === 2 ? 1 : null,
      deathCause: null,
      isSheriff: false,
    })),
  });
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
