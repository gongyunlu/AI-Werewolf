import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './GamesListPage.module.css';
import { apiClient } from '@/lib/api-client';
import type { GameListItem } from '@/types/game';
import { AppHeader } from '@/components/AppHeader';
import { CreateGameDialog } from '@/components/CreateGameDialog';
import { PerspectiveDialog } from '@/components/game-watch/PerspectiveDialog';
import { Button } from '@/components/ui/button';
import { GAME_STATUSES, FACTIONS } from '@ai-werewolf/shared';

const STATUS_BADGE_CLASS: Record<string, string> = {
  [GAME_STATUSES.CREATED]: [styles.badge, styles.badgeSolid].join(' '),
  [GAME_STATUSES.INITIALIZED]: [styles.badge, styles.badgeSolid].join(' '),
  [GAME_STATUSES.PENDING]: [styles.badge, styles.badgeSoft, styles.badgeAmber].join(' '),
  [GAME_STATUSES.RUNNING]: [styles.badge, styles.badgeSoft, styles.badgeCyan].join(' '),
  [GAME_STATUSES.PAUSED]: [styles.badge, styles.badgeSoft, styles.badgeOrange].join(' '),
  [GAME_STATUSES.PENDING_RECOVERY]: [styles.badge, styles.badgeSoft, styles.badgePurple].join(' '),
  [GAME_STATUSES.FINISHED]: [styles.badge, styles.badgeSolidDim].join(' '),
  [GAME_STATUSES.ABORTED]: [styles.badge, styles.badgeSoft, styles.badgeRed].join(' '),
};

const WINNER_BADGE_CLASS: Record<string, string> = {
  [FACTIONS.VILLAGER]: [styles.badge, styles.badgeSoft, styles.badgeGreen].join(' '),
  [FACTIONS.WEREWOLF]: [styles.badge, styles.badgeSoft, styles.badgeRed].join(' '),
  [FACTIONS.THIRD_PARTY]: [styles.badge, styles.badgeSoft, styles.badgePurple].join(' '),
};

function getStatusBadge(status: string) {
  const labels: Record<string, string> = {
    [GAME_STATUSES.CREATED]: '已创建',
    [GAME_STATUSES.INITIALIZED]: '已初始化',
    [GAME_STATUSES.PENDING]: '待开始',
    [GAME_STATUSES.RUNNING]: '进行中',
    [GAME_STATUSES.PAUSED]: '已暂停',
    [GAME_STATUSES.PENDING_RECOVERY]: '待恢复',
    [GAME_STATUSES.FINISHED]: '已结束',
    [GAME_STATUSES.ABORTED]: '已终止',
  };
  const label = labels[status] ?? status;
  const cls = STATUS_BADGE_CLASS[status] ?? [styles.badge, styles.badgeSolid].join(' ');
  return <span className={cls}>{label}</span>;
}

function getWinnerBadge(faction: string | null) {
  if (!faction) return null;
  const labels: Record<string, string> = {
    [FACTIONS.VILLAGER]: '好人胜',
    [FACTIONS.WEREWOLF]: '狼人胜',
    [FACTIONS.THIRD_PARTY]: '第三方胜',
  };
  const label = labels[faction];
  if (!label) return null;
  return <span className={WINNER_BADGE_CLASS[faction]}>{label}</span>;
}

export default function GamesListPage() {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);

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

  const handleCreated = (gameId: string) => {
    setPendingGameId(gameId);
  };

  // 列表页点击"观战"时，配合 PerspectiveDialog 选择视角后进入页面
  const handleWatch = (gameId: string) => {
    setPendingGameId(gameId);
  };

  const handleSelectPerspective = (perspective: string) => {
    if (!pendingGameId) return;
    sessionStorage.setItem(`perspective-${pendingGameId}`, perspective);
    const id = pendingGameId;
    setPendingGameId(null);
    void fetchGames();
    navigate(`/games/${id}`);
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      setPendingGameId(null);
    }
  };

  return (
    <div className={styles.page}>
      <AppHeader />
      <PerspectiveDialog
        open={!!pendingGameId}
        onOpenChange={handleDialogClose}
        onSelect={handleSelectPerspective}
      />

      <div className={styles.body}>
        <div className={styles.container}>
          <div className={styles.hero}>
            <div className={styles.heroText}>
              <h1 className={styles.title}>对局列表</h1>
              <p className={styles.subtitle}>查看所有游戏对局</p>
            </div>
            <CreateGameDialog onCreated={handleCreated} />
          </div>

          {loading ? (
            <div className={styles.loading}>
              <div className={styles.loadingText}>加载中...</div>
            </div>
          ) : games.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyText}>暂无对局</p>
            </div>
          ) : (
            <div className={styles.list}>
              {games.map((game) => {
                const players = game.players || [];
                const aliveCount = players.filter((p) => p.deathDay === null).length;
                const totalPlayers = players.length;

                return (
                  <div key={game.id} className={styles.card}>
                    <div className={styles.cardBody}>
                      <div className={styles.info}>
                        <div className={styles.metaRow}>
                          <span className={styles.gameId}>#{game.id.slice(0, 8)}</span>
                          {getStatusBadge(game.status)}
                          {getWinnerBadge(game.winnerFaction)}
                        </div>
                        <div className={styles.metaDetails}>
                          <span>{game.ruleset?.name || '未知规则集'}</span>
                          <span>•</span>
                          <span>{totalPlayers} 人局</span>
                          {game.status === 'running' && totalPlayers > 0 && (
                            <>
                              <span>•</span>
                              <span className={styles.aliveCount}>{aliveCount} 人存活</span>
                            </>
                          )}
                          {game.totalDays != null && (
                            <>
                              <span>•</span>
                              <span>第 {game.totalDays} 天</span>
                            </>
                          )}
                          <span>•</span>
                          <span>{new Date(game.startedAt).toLocaleString('zh-CN')}</span>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className={styles.watchButton}
                        onClick={() => handleWatch(game.id)}
                      >
                        观战
                      </Button>
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
