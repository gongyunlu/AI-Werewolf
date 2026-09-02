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

  it('开始/补全分析不启用 force，且投递后不立即用旧汇总显示完成', async () => {
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText('4 / 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '开始/补全分析' }));

    await waitFor(() => {
      expect(apiClientMock.analyzeGame).toHaveBeenCalledWith('game-1', {
        judge: true,
        reflect: true,
      });
    });
    expect(apiClientMock.getAnalysisStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('4 / 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText(/已投递：评分 2 项、反思 6 人/)).toBeInTheDocument();
  });

  it('只有显式重跑反思时传 force=true', async () => {
    render(<AnalysisDialog gameId="game-1" onOpenChange={vi.fn()} />);
    await screen.findByText('4 / 4');

    fireEvent.click(screen.getByRole('button', { name: '只重跑反思' }));

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

    fireEvent.click(screen.getByRole('button', { name: '开始/补全分析' }));

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

    fireEvent.click(screen.getByRole('button', { name: '开始/补全分析' }));
    await screen.findByText(/已投递：评分 2 项、反思 6 人/);
    resolveStatus?.(COMPLETE_STATUS);

    await waitFor(() => expect(apiClientMock.getAnalysisStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('4 / 4')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });
});
