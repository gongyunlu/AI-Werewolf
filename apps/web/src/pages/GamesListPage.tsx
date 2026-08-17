import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import type { GameListItem } from '@/types/game';
import { AppHeader } from '@/components/AppHeader';
import { CreateGameDialog } from '@/components/CreateGameDialog';
import { GAME_STATUSES, FACTIONS } from '@ai-werewolf/shared';

function getStatusBadge(status: string) {
  const badges: Record<string, { label: string; className: string }> = {
    [GAME_STATUSES.CREATED]: { label: '已创建', className: 'bg-slate-700 text-slate-300' },
    [GAME_STATUSES.INITIALIZED]: { label: '已初始化', className: 'bg-slate-600 text-slate-300' },
    [GAME_STATUSES.PENDING]: { label: '待开始', className: 'bg-amber-500/20 text-amber-400' },
    [GAME_STATUSES.RUNNING]: { label: '进行中', className: 'bg-cyan-500/20 text-cyan-400' },
    [GAME_STATUSES.PAUSED]: { label: '已暂停', className: 'bg-orange-500/20 text-orange-400' },
    [GAME_STATUSES.PENDING_RECOVERY]: {
      label: '待恢复',
      className: 'bg-purple-500/20 text-purple-400',
    },
    [GAME_STATUSES.FINISHED]: { label: '已结束', className: 'bg-slate-600 text-slate-400' },
    [GAME_STATUSES.ABORTED]: { label: '已终止', className: 'bg-red-500/20 text-red-400' },
  };
  const badge = badges[status] || { label: status, className: 'bg-slate-700 text-slate-300' };
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function getWinnerBadge(faction: string | null) {
  if (!faction) return null;
  const badges: Record<string, { label: string; className: string }> = {
    [FACTIONS.VILLAGER]: { label: '好人胜', className: 'bg-green-500/20 text-green-400' },
    [FACTIONS.WEREWOLF]: { label: '狼人胜', className: 'bg-red-500/20 text-red-400' },
    [FACTIONS.THIRD_PARTY]: { label: '第三方胜', className: 'bg-purple-500/20 text-purple-400' },
  };
  const badge = badges[faction];
  if (!badge) return null;
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

export default function GamesListPage() {
  const [games, setGames] = useState<GameListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchGames = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getGames({
        pageSize: 20,
        sortBy: 'startedAt',
        sortOrder: 'desc',
      });
      setGames(response.items);
    } catch (err) {
      console.error('加载对局列表失败:', err);
      setGames([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchGames();
  }, []);

  const handleCreated = () => {
    void fetchGames();
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950">
      <AppHeader />

      <div className="flex-1 p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-slate-200">对局列表</h1>
              <p className="mt-1 text-slate-400">查看所有游戏对局</p>
            </div>
            <CreateGameDialog onCreated={handleCreated} />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-slate-400">加载中...</div>
            </div>
          ) : games.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
              <p className="text-slate-400">暂无对局</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {games.map((game) => {
                const players = game.players || [];
                const aliveCount = players.filter((p) => p.deathDay === null).length;
                const totalPlayers = players.length;

                return (
                  <div
                    key={game.id}
                    className="bg-slate-900 border border-slate-800 rounded-lg p-6"
                  >
                    <div className="flex items-center justify-between">
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500 text-sm font-mono">
                            #{game.id.slice(0, 8)}
                          </span>
                          {getStatusBadge(game.status)}
                          {getWinnerBadge(game.winnerFaction)}
                        </div>
                        <div className="flex items-center gap-4 text-sm text-slate-400">
                          <span>{game.ruleset?.name || '未知规则集'}</span>
                          <span>•</span>
                          <span>{totalPlayers} 人局</span>
                          {game.status === 'running' && totalPlayers > 0 && (
                            <>
                              <span>•</span>
                              <span className="text-cyan-400">{aliveCount} 人存活</span>
                            </>
                          )}
                          {game.totalDays && (
                            <>
                              <span>•</span>
                              <span>第 {game.totalDays} 天</span>
                            </>
                          )}
                          <span>•</span>
                          <span>{new Date(game.startedAt).toLocaleString('zh-CN')}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
