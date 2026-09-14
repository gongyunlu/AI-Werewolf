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
  const [game, setGame] = useState<GameListItem | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const playerDeathsRef = useRef(new Map<string, PlayerDeathSnapshot>());

  const { state, handleMessage } = useSceneEngine(perspective);
  const nightActionState = useNightActionState(state.closedScenes);

  const onMessage = useCallback(
    (msg: SseMessage) => {
      handleMessage(msg);
      if (msg.type === 'connection.ready') {
        playerDeathsRef.current = new Map(msg.playerDeaths.map((death) => [death.playerId, death]));
        setGame((prev) => (prev ? applyPlayerDeaths(prev, playerDeathsRef.current) : prev));
      }
      // 玩家出局：同步更新头像死亡状态（对局中 game 只拉取一次，需靠 SSE 事件驱动）
      if (msg.type === 'player.died') {
        playerDeathsRef.current.set(msg.playerId, msg);
        setGame((prev) =>
          prev
            ? {
                ...prev,
                players: prev.players.map((p) =>
                  p.id === msg.playerId
                    ? { ...p, deathDay: msg.deathDay, deathCause: msg.deathCause }
                    : p,
                ),
              }
            : prev,
        );
      }
      // 终局（正常结束或引擎中止）：回读一次 DB 状态，同步 status 以便切断 SSE、头部按终态渲染
      if (msg.type === 'game.finished' && gameId) {
        apiClient
          .getGame(gameId)
          .then((g) => setGame(applyPlayerDeaths(g, playerDeathsRef.current)))
          .catch(() => null);
      }
    },
    [handleMessage, gameId],
  );

  useEffect(() => {
    playerDeathsRef.current = new Map();
    setGame(null);
  }, [gameId]);

  const isRunning = game?.id === gameId && game?.status === GAME_STATUSES.RUNNING;
  // 对局中止（引擎/规则异常导致整局报废）：live 时 SSE 以 game.finished/winner=unknown 到达，
  // 中止后刷新则读 DB status=aborted——两种都归为「对局已中止」，与正常结束分开呈现。
  const isAborted =
    game?.status === GAME_STATUSES.ABORTED || (state.gameOver && state.winner === 'unknown');

  useGameStream(gameId ?? '', perspective, onMessage, { enabled: isRunning });

  useEffect(() => {
    if (!gameId) return;
    apiClient
      .getGame(gameId)
      .then((loadedGame) => setGame(applyPlayerDeaths(loadedGame, playerDeathsRef.current)))
      .catch(() => null);
  }, [gameId]);

  // 兜底轮询：SSE 是纯内存广播，`game.finished` 只在流仍连接时送达，断流/重连窗口可能错过终局事件。
  // 只要页面认为对局在跑，就周期回读 DB 状态；一旦变成 aborted/finished 即反映到头部并停掉 SSE。
  const runningGameId = game?.status === GAME_STATUSES.RUNNING ? gameId : null;
  useEffect(() => {
    if (!runningGameId) return;
    const timer = setInterval(() => {
      apiClient
        .getGame(runningGameId)
        .then((fresh) => setGame(applyPlayerDeaths(fresh, playerDeathsRef.current)))
        .catch(() => null);
    }, 8000);
    return () => clearInterval(timer);
  }, [runningGameId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.closedScenes.length]);

  const handleStartGame = async () => {
    if (!gameId) return;
    setIsStarting(true);
    try {
      // startGame 已返回更新后的对局（含 running 状态），无需再 getGame
      const updated = await apiClient.startGame(gameId);
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
                  key={scene.sceneId}
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
