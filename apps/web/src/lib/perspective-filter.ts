import type { Player, Speech, ViewPerspective, FilteredPlayer, FilteredSpeech } from '@/types/game';
import { PHASES } from '@ai-werewolf/shared';

/**
 * 根据视角过滤玩家信息
 * - god: 上帝视角，所有信息可见
 * - werewolf: 狼人视角，只能看到狼人阵营信息
 * - villager: 村民视角，只能看到公开信息
 * - number: 特定玩家视角，只能看到该玩家知道的信息
 */
export function filterPlayerByPerspective(
  player: Player,
  perspective: ViewPerspective,
  allPlayers: Player[],
): FilteredPlayer {
  // 上帝视角：所有信息可见
  if (perspective === 'god') {
    return { ...player, isVisible: true };
  }

  // 狼人阵营视角：可以看到所有狼人
  if (perspective === 'werewolf') {
    return {
      ...player,
      role: player.camp === 'werewolf' ? player.role : undefined,
      camp: player.camp === 'werewolf' ? player.camp : undefined,
      isVisible: true,
    };
  }

  // 村民阵营视角：只能看到公开信息（已死亡玩家的角色）
  if (perspective === 'villager') {
    return {
      ...player,
      role: player.status === 'dead' ? player.role : undefined,
      camp: player.status === 'dead' ? player.camp : undefined,
      isVisible: true,
    };
  }

  // 特定玩家视角
  if (typeof perspective === 'number') {
    const currentPlayer = allPlayers.find((p) => p.seatNumber === perspective);
    if (!currentPlayer) {
      return { ...player, role: undefined, camp: undefined, isVisible: true };
    }

    // 自己的信息完全可见
    if (player.seatNumber === perspective) {
      return { ...player, isVisible: true };
    }

    // 如果当前玩家是狼人，可以看到其他狼人
    if (currentPlayer.camp === 'werewolf' && player.camp === 'werewolf') {
      return { ...player, isVisible: true };
    }

    // 已死亡玩家的角色公开
    if (player.status === 'dead') {
      return { ...player, isVisible: true };
    }

    // 其他情况只能看到基础信息
    return {
      ...player,
      role: undefined,
      camp: undefined,
      isVisible: true,
    };
  }

  return { ...player, isVisible: true };
}

/**
 * 根据视角过滤发言
 * - god: 所有发言可见
 * - werewolf: 狼人视角，可以看到狼人夜间讨论
 * - villager: 村民视角，只能看到白天公开发言
 * - number: 特定玩家视角，根据玩家身份决定
 */
export function filterSpeechByPerspective(
  speech: Speech,
  perspective: ViewPerspective,
  allPlayers: Player[],
): FilteredSpeech {
  // 上帝视角：所有发言可见
  if (perspective === 'god') {
    return { ...speech, isVisible: true };
  }

  // 白天阶段的发言对所有人可见
  if (speech.phase === PHASES.SPEECH || speech.phase === PHASES.VOTE) {
    return { ...speech, isVisible: true };
  }

  // 夜间发言的可见性
  const speaker = allPlayers.find((p) => p.seatNumber === speech.seatNumber);
  if (!speaker) {
    return { ...speech, isVisible: false };
  }

  // 狼人阵营视角：可以看到狼人的夜间讨论
  if (perspective === 'werewolf') {
    return {
      ...speech,
      isVisible: speaker.camp === 'werewolf',
    };
  }

  // 村民阵营视角：看不到夜间发言
  if (perspective === 'villager') {
    return { ...speech, isVisible: false };
  }

  // 特定玩家视角
  if (typeof perspective === 'number') {
    const currentPlayer = allPlayers.find((p) => p.seatNumber === perspective);
    if (!currentPlayer) {
      return { ...speech, isVisible: false };
    }

    // 自己的发言可见
    if (speech.seatNumber === perspective) {
      return { ...speech, isVisible: true };
    }

    // 如果当前玩家是狼人，可以看到其他狼人的夜间讨论
    if (currentPlayer.camp === 'werewolf' && speaker.camp === 'werewolf') {
      return { ...speech, isVisible: true };
    }

    return { ...speech, isVisible: false };
  }

  return { ...speech, isVisible: false };
}

/**
 * 批量过滤玩家信息
 */
export function filterPlayers(players: Player[], perspective: ViewPerspective): FilteredPlayer[] {
  return players.map((player) => filterPlayerByPerspective(player, perspective, players));
}

/**
 * 批量过滤发言记录
 */
export function filterSpeeches(
  speeches: Speech[],
  perspective: ViewPerspective,
  allPlayers: Player[],
): FilteredSpeech[] {
  return speeches
    .map((speech) => filterSpeechByPerspective(speech, perspective, allPlayers))
    .filter((speech) => speech.isVisible);
}
