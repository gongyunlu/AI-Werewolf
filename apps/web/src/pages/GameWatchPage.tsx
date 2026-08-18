import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import styles from './GameWatchPage.module.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PlayerCard } from '@/components/game-watch/PlayerCard';
import { SceneCard } from '@/components/game-watch/SceneCard';
import { ActiveSceneCard } from '@/components/game-watch/ActiveSceneCard';
import { useGameStream } from '@/hooks/useGameStream';
import { useSceneEngine } from '@/hooks/useSceneEngine';
import { apiClient } from '@/lib/api-client';
import type { GameListItem } from '@/types/game';
import type { SseMessage } from '@/types/sse';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { Play } from 'lucide-react';

const PERSPECTIVE_LABELS: Record<string, string> = {
  god: '上帝视角',
  villager: '闭眼视角',
};

export default function GameWatchPage() {
  const { id: gameId } = useParams<{ id: string }>();
  const perspective = gameId ? (sessionStorage.getItem(`perspective-${gameId}`) ?? 'god') : 'god';
  const [game, setGame] = useState<GameListItem | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { state, handleMessage } = useSceneEngine();

  const onMessage = useCallback((msg: SseMessage) => handleMessage(msg), [handleMessage]);

  const isRunning = game?.status === GAME_STATUSES.RUNNING;

  useGameStream(gameId ?? '', perspective, onMessage, { enabled: isRunning });

  useEffect(() => {
    if (!gameId) return;
    apiClient
      .getGame(gameId)
      .then(setGame)
      .catch(() => null);
  }, [gameId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.closedScenes.length]);

  const handleStartGame = async () => {
    if (!gameId) return;
    setIsStarting(true);
    try {
      await apiClient.startGame(gameId);
      const updated = await apiClient.getGame(gameId);
      setGame(updated);
    } catch (error) {
      console.error('启动对局失败:', error);
    } finally {
      setIsStarting(false);
    }
  };

  // 玩家列表：按座次升序排列，左侧一半、右侧一半；未分配座次(null)排在最后
  const players = [...(game?.players ?? [])].toSorted((a, b) => {
    if (a.seatNo === null) return 1;
    if (b.seatNo === null) return -1;
    return a.seatNo - b.seatNo;
  });
  const half = Math.ceil(players.length / 2);
  const leftPlayers = players.filter((_, i) => i < half);
  const rightPlayers = players.filter((_, i) => i >= half);

  // 获取当前活动场景的演员信息
  const activeScene = state.activeScene;
  const activeActorId = activeScene?.actorId;
  const activeActor = activeActorId
    ? players.find((p) => p.seatNo === parseInt(activeActorId))
    : null;

  return (
    <div className={`dark ${styles.page}`}>
      {/* HEADER */}
      <div className={styles.header}>
        <span className={styles.gameId}>#{gameId?.slice(0, 8)}</span>
        {game && <span className={styles.rulesetName}>{game.ruleset?.name}</span>}
        {state.gameOver ? (
          <Badge variant="secondary">已结束 · {state.winner}</Badge>
        ) : (
          <Badge variant="outline">观战中</Badge>
        )}
        <div className={styles.headerActions}>
          {(game?.status === GAME_STATUSES.CREATED ||
            game?.status === GAME_STATUSES.INITIALIZED ||
            game?.status === GAME_STATUSES.PENDING) && (
            <Button onClick={handleStartGame} disabled={isStarting} size="sm">
              <Play />
              开始对局
            </Button>
          )}
          <Badge variant="outline">{PERSPECTIVE_LABELS[perspective] ?? perspective}</Badge>
        </div>
      </div>

      {/* 三栏布局 */}
      <div className={styles.columns}>
        {/* 左侧玩家列表 - grid 占满高度，固定 6 行 */}
        <aside className={`${styles.sidebar} ${styles.sidebarLeft}`}>
          <div className={styles.sidebarGrid}>
            {leftPlayers.map((player, index) => (
              <div key={player.id} className={styles.sidebarCell}>
                <PlayerCard player={player} index={index} isLeft />
              </div>
            ))}
          </div>
        </aside>

        {/* 中央内容区域 */}
        <main className={styles.main}>
          {/* 当前发言角色卡片 */}
          {activeActor && (
            <div className={styles.activeActor}>
              <div className={styles.activeActorInner}>
                <div className={styles.activeActorAvatar}>{activeActor.seatNo}</div>
                <div className={styles.activeActorText}>
                  <h2 className={styles.activeActorName}>{activeActor.displayName}</h2>
                  {activeActor.role && activeActor.faction && (
                    <Badge variant="outline" className={styles.activeActorRoleBadge}>
                      {activeActor.role} · {activeActor.faction}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 场景流 */}
          <div className={styles.sceneFlow}>
            {state.closedScenes.map((scene) => (
              <SceneCard
                key={scene.sceneId}
                sceneId={scene.sceneId}
                sceneType={scene.sceneType}
                actorId={scene.actorId}
                fullContent={scene.fullContent}
                durationMs={scene.durationMs}
              />
            ))}
            {state.activeScene && (
              <ActiveSceneCard
                sceneType={state.activeScene.sceneType}
                actorId={state.activeScene.actorId}
                displayText={state.displayText}
                isTyping
              />
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        {/* 右侧玩家列表 - grid 占满高度，固定 6 行 */}
        <aside className={`${styles.sidebar} ${styles.sidebarRight}`}>
          <div className={styles.sidebarGrid}>
            {rightPlayers.map((player, index) => (
              <div key={player.id} className={styles.sidebarCell}>
                <PlayerCard player={player} index={leftPlayers.length + index} isLeft={false} />
              </div>
            ))}
          </div>
        </aside>
      </div>

      {/* 初始化遮罩 */}
      {isStarting && (
        <div className={styles.overlay}>
          <div className={styles.overlayContent}>
            <div className={styles.spinner} />
            <p className={styles.overlayText}>初始化对局中，正在随机分配角色和座次...</p>
          </div>
        </div>
      )}
    </div>
  );
}
