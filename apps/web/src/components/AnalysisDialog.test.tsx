import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisDialog } from './AnalysisDialog';

const apiClientMock = vi.hoisted(() => ({
  getAnalysisStatus: vi.fn(),
  analyzeGame: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: apiClientMock,
}));

const COMPLETE_STATUS = {
  judgedCount: 4,
  judgeableCount: 4,
  judgeComplete: true,
  reflectedCount: 6,
  playerCount: 6,
  narrativeReady: true,
};

describe('AnalysisDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock.getAnalysisStatus.mockResolvedValue(COMPLETE_STATUS);
    apiClientMock.analyzeGame.mockResolvedValue({
      judged: 2,
      reflectPlanned: 6,
      skipped: false,
    });
  });

  it('开始或继续分析复用已有结果，投递后不立即用旧汇总显示完成', async () => {
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText('4 / 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '开始/继续分析' }));

    await waitFor(() => {
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('game-1', {
        judge: true,
        reflect: true,
        force: false,
      });
    });
    expect(apiClientMock.getAnalysisStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('4 / 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getByText(/已投递：评分 2 项、反思 6 人/)).toBeInTheDocument();
  });

  it('重跑评分只投评分并强制重跑', async () => {
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    await screen.findByText('4 / 4');

    fireEvent.click(screen.getByRole('button', { name: '重跑评分' }));

    await waitFor(() => {
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('game-1', {
        judge: true,
        reflect: false,
        force: true,
      });
    });
  });

  it('A/B 入口提供独立评分和反思操作，说明不写回经验', async () => {
    render(<AnalysisDialog gameId="ab-game" experiment onOpenChange={vi.fn()} />);
    await screen.findByText('4 / 4');
    expect(screen.getByText(/不写回经验、对手建模或全局记忆/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始/继续分析' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'A/B 反思' }));
    await waitFor(() =>
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('ab-game', {
        judge: false,
        reflect: true,
        force: true,
      }),
    );
    await screen.findByText(/已投递/);
    fireEvent.click(screen.getByRole('button', { name: 'A/B 评分' }));
    await waitFor(() =>
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('ab-game', {
        judge: true,
        reflect: false,
        force: true,
      }),
    );
  });

  it('重跑反思只投反思并强制重跑', async () => {
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    await screen.findByText('4 / 4');

    fireEvent.click(screen.getByRole('button', { name: '重跑反思' }));

    await waitFor(() => {
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('game-1', {
        judge: false,
        reflect: true,
        force: true,
      });
    });
  });

  it('后端跳过投递时不谎报「已投递」', async () => {
    apiClientMock.analyzeGame.mockResolvedValue({
      judged: 0,
      reflectPlanned: 0,
      skipped: true,
    });
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    await screen.findByText('4 / 4');

    fireEvent.click(screen.getByRole('button', { name: '开始/继续分析' }));

    expect(await screen.findByText(/未重新投递/)).toBeInTheDocument();
    expect(screen.queryByText(/已投递：/)).not.toBeInTheDocument();
  });

  it('投递成功会作废尚未返回的旧进度请求', async () => {
    let resolveStatus: ((status: typeof COMPLETE_STATUS) => void) | undefined;
    apiClientMock.getAnalysisStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '开始/继续分析' }));
    await screen.findByText(/已投递：评分 2 项、反思 6 人/);
    resolveStatus?.(COMPLETE_STATUS);

    await waitFor(() => expect(apiClientMock.getAnalysisStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('4 / 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it.each([
    { judgedCount: 1, judgeComplete: false, state: '判分未完成' },
    { judgedCount: 4, judgeComplete: false, state: '待采用' },
    { judgedCount: 4, judgeComplete: true, state: '已采用' },
  ])('展示已保存判分并区分采用状态：$state', async ({ state, ...progress }) => {
    apiClientMock.getAnalysisStatus.mockResolvedValue({
      ...COMPLETE_STATUS,
      ...progress,
      reflectedCount: 0,
      narrativeReady: false,
    });
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText(`${progress.judgedCount} / 4`)).toBeInTheDocument();
    expect(screen.getByText(state)).toBeInTheDocument();
    expect(screen.getByText('0 / 6')).toBeInTheDocument();
    expect(screen.getByText(/评分采用完成后才开始复盘与反思/)).toBeInTheDocument();
  });
});
