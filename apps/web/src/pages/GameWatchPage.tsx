import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import styles from './GameWatchPage.module.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PlayerCard } from '@/components/game-watch/PlayerCard';
import { SceneCard } from '@/components/game-watch/SceneCard';
import { ActiveSceneCard } from '@/components/game-watch/ActiveSceneCard';
import { AppHeader } from '@/components/AppHeader';
import { useGameStream } from '@/hooks/useGameStream';
import { useSceneEngine } from '@/hooks/useSceneEngine';
import { useNightActionState } from '@/hooks/useNightActionState';
import { apiClient } from '@/lib/api-client';
import type { GameListItem } from '@/types/game';
import type { PlayerDeathSnapshot, SseMessage } from '@/types/sse';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { Play } from 'lucide-react';

const PERSPECTIVE_LABELS: Record<string, string> = {
  god: '上帝视角',
  villager: '闭眼视角',
};

export default function GameWatchPage() {
  const { id: gameId } = useParams<{ id: string }>();
  // 视角只读一次；sessionStorage 在隐私模式/配额满时会抛异常，需 try-catch 兜底
  const perspective = useMemo(() => {
    if (!gameId) return 'god';
    try {
      return sessionStorage.getItem(`perspective-${gameId}`) ?? 'god';
    } catch {
      return 'god';
    }
  }, [gameId]);
  // 切局时整体销毁旧场景、定时器及请求引用，未开始的新局也不能保留上一局历史。
  return <GameWatchContent key={gameId} gameId={gameId} perspective={perspective} />;
}

function GameWatchContent({ gameId, perspective }: { gameId?: string; perspective: string }) {
  const [game, setGame] = useState<GameListItem | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const playerDeathsRef = useRef(new Map<string, PlayerDeathSnapshot>());
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const readingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const refreshGame = useCallback(async () => {
    if (!gameId || readingRef.current) return;
    readingRef.current = true;
    const request = ++requestRef.current;
    try {
      const loaded = await apiClient.getGame(gameId);
      if (mountedRef.current && request === requestRef.current)
        setGame(applyPlayerDeaths(loaded, playerDeathsRef.current));
    } catch {
      /* 连接恢复及状态轮询会重新读取。 */
    } finally {
      readingRef.current = false;
    }
  }, [gameId]);

  const { state, handleMessage } = useSceneEngine(perspective);
  const nightActionState = useNightActionState(state.closedScenes);

  const onMessage = useCallback(
    (msg: SseMessage) => {
      handleMessage(msg);
      if (msg.type === 'connection.ready' || msg.type === 'events.committed') {
        if (msg.type === 'connection.ready') playerDeathsRef.current = new Map();
        for (const death of msg.playerDeaths) playerDeathsRef.current.set(death.playerId, death);
        if (msg.type === 'connection.ready') requestRef.current++;
        setGame((prev) =>
          prev
            ? applyPlayerDeaths(
                {
                  ...prev,
                  status:
                    msg.type === 'connection.ready' ? (msg.gameStatus ?? prev.status) : prev.status,
                },
                playerDeathsRef.current,
              )
            : prev,
        );
      }
      // 终局（正常结束或引擎中止）：回读一次 DB 状态，同步 status 以便切断 SSE、头部按终态渲染
      if (
        gameId &&
        (msg.type === 'game.finished' ||
          ((msg.type === 'events.committed' || msg.type === 'connection.ready') &&
            msg.gameFinished))
      ) {
        void refreshGame();
      }
    },
    [handleMessage, gameId, refreshGame],
  );

  // 对局中止（引擎/规则异常导致整局报废）：live 时 SSE 以 game.finished/winner=unknown 到达，
  // 中止后刷新则读 DB status=aborted——两种都归为「对局已中止」，与正常结束分开呈现。
  const isAborted =
    game?.status === GAME_STATUSES.ABORTED || (state.gameOver && state.winner === 'unknown');

  useGameStream(gameId ?? '', perspective, onMessage, {
    enabled: !!game && game.id === gameId && game.status !== GAME_STATUSES.CREATED,
    revision: game?.status,
  });

  useEffect(() => {
    void refreshGame();
  }, [refreshGame]);

  // 无 Event 的取消／待恢复通知可能丢失；状态变化后重新连接并读取完整持久快照。
  const runningGameId =
    game?.status === GAME_STATUSES.RUNNING || game?.status === GAME_STATUSES.PENDING_RECOVERY
      ? gameId
      : null;
  useEffect(() => {
    if (!runningGameId) return;
    const timer = setInterval(() => {
      void refreshGame();
    }, 8000);
    return () => clearInterval(timer);
  }, [runningGameId, refreshGame]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.closedScenes.length]);

  const handleStartGame = async () => {
    if (!gameId) return;
    setIsStarting(true);
    requestRef.current++;
    try {
      // startGame 已返回更新后的对局（含 running 状态），无需再 getGame
      const updated = await apiClient.startGame(gameId);
      if (mountedRef.current) {
        requestRef.current++;
        setGame(updated);
      }
    } catch (error) {
      console.error('启动对局失败:', error);
    } finally {
      if (mountedRef.current) setIsStarting(false);
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
  const activeActor = activeActorId ? players.find((p) => p.id === activeActorId) : null;

  return (
    <div className={styles.page}>
      <AppHeader />
      {/* 对局信息与操作 */}
      <div className={styles.header}>
        <div className={styles.gameInfo}>
          <h1 className={styles.rulesetName}>{game?.ruleset?.name ?? '对局观战'}</h1>
          <span className={styles.gameId}>#{gameId?.slice(0, 8)}</span>
        </div>
        {isAborted ? (
          <Badge variant="destructive">对局已中止</Badge>
        ) : state.gameOver ? (
          <Badge variant="secondary">已结束 · {state.winner}</Badge>
        ) : game?.status === GAME_STATUSES.FINISHED ? (
          <Badge variant="secondary">已结束</Badge>
        ) : game?.status === GAME_STATUSES.PENDING_RECOVERY ? (
          <Badge variant="secondary">等待恢复</Badge>
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
        {/* 左侧固定 6 行，玩家不足时保留空位 */}
        <aside className={styles.sidebar} aria-label="左侧玩家">
          <div className={styles.sidebarGrid}>
            {leftPlayers.map((player, index) => (
              <div key={player.id} className={styles.sidebarCell}>
                <PlayerCard
                  player={player}
                  index={index}
                  isLeft
                  hasWolfMark={
                    player.seatNo !== null &&
                    nightActionState.wolfTarget === player.seatNo &&
                    nightActionState.witchSaved !== player.seatNo
                  }
                />
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
                  <Badge variant="outline">正在发言</Badge>
                </div>
              </div>
            </div>
          )}

          {/* 场景流 */}
          <div className={styles.sceneFlow}>
            {state.closedScenes.length === 0 && !activeScene && (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon} aria-hidden="true">
                  ◌
                </span>
                <h2>等待对局动态</h2>
                <p>玩家发言、投票与法官播报将在这里按顺序呈现。</p>
              </div>
            )}
            {state.closedScenes.map((scene) => {
              const actor = scene.actorId ? players.find((p) => p.id === scene.actorId) : null;
              return (
                <SceneCard
                  key={scene.eventId ?? scene.sceneId}
                  sceneId={scene.sceneId}
                  sceneType={scene.sceneType}
                  actorId={scene.actorId}
                  actorName={actor?.displayName}
                  actorSeatNo={actor?.seatNo ?? undefined}
                  thinking={scene.thinking}
                  content={scene.content}
                  thinkingDurationMs={scene.thinkingDurationMs}
                  contentDurationMs={scene.contentDurationMs}
                  metadata={scene.metadata}
                />
              );
            })}
            {state.activeScene && (
              <ActiveSceneCard
                sceneType={state.activeScene.sceneType}
                actorId={state.activeScene.actorId}
                actorName={activeActor?.displayName}
                actorSeatNo={activeActor?.seatNo ?? undefined}
                thinking={state.activeScene.thinking}
                content={state.activeScene.content}
                isTyping
              />
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        {/* 右侧固定 6 行，玩家不足时保留空位 */}
        <aside className={styles.sidebar} aria-label="右侧玩家">
          <div className={styles.sidebarGrid}>
            {rightPlayers.map((player, index) => (
              <div key={player.id} className={styles.sidebarCell}>
                <PlayerCard
                  player={player}
                  index={leftPlayers.length + index}
                  isLeft={false}
                  hasWolfMark={
                    player.seatNo !== null &&
                    nightActionState.wolfTarget === player.seatNo &&
                    nightActionState.witchSaved !== player.seatNo
                  }
                />
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

function applyPlayerDeaths(
  game: GameListItem,
  deaths: Map<string, PlayerDeathSnapshot>,
): GameListItem {
  if (deaths.size === 0) return game;

  return {
    ...game,
    players: game.players.map((player) => {
      const death = deaths.get(player.id);
      return death ? { ...player, deathDay: death.deathDay, deathCause: death.deathCause } : player;
    }),
  };
}
