import { ROLES, VISIBILITY_TYPES } from '@ai-werewolf/shared';

/**
 * 玩家可见性输入（判断某玩家有权看到哪些 visibility 的事件）
 */
export interface VisibilityInput {
  role: string | null;
  isAlive: boolean;
  hasUsedAntidote: boolean;
}

/**
 * 计算玩家可见的事件类型集合
 */
export function getVisibleVisibilitiesForRole(input: VisibilityInput): string[] {
  const { role, isAlive, hasUsedAntidote } = input;
  const visibilities: string[] = [VISIBILITY_TYPES.PUBLIC]; // 所有人可见 public

  if (!role) {
    return visibilities;
  }

  switch (role) {
    case ROLES.SEER:
      visibilities.push(VISIBILITY_TYPES.SEER);
      break;
    case ROLES.WITCH:
      visibilities.push(VISIBILITY_TYPES.WITCH);
      if (isAlive && !hasUsedAntidote) {
        visibilities.push(VISIBILITY_TYPES.WOLF_KILL);
      }
      break;
    case ROLES.WEREWOLF:
      visibilities.push(VISIBILITY_TYPES.WOLF);
      visibilities.push(VISIBILITY_TYPES.WOLF_KILL);
      break;
    case ROLES.GUARD:
      visibilities.push(VISIBILITY_TYPES.GUARD);
      break;
  }

  return visibilities;
}

interface HistoricalEvent {
  sequence: number;
  day: number | null;
  visibility: string;
  actionType: string;
  actorId?: string | null;
  content: unknown;
}

/** 按观察发生时的权限保留事实；失去新刀口资格不会抹去女巫以前的观察。 */
export function getHistoricallyVisibleEvents<T extends HistoricalEvent>(
  player: { id: string; role: string | null; deathDay: number | null },
  events: T[],
): T[] {
  const visible = getVisibleVisibilitiesForRole({
    role: player.role,
    isAlive: false,
    hasUsedAntidote: true,
  });
  const antidoteSequence = Math.min(
    Infinity,
    ...events
      .filter(
        (event) =>
          event.actionType === 'witch_save' &&
          event.actorId === player.id &&
          (event.content as { saved?: boolean } | null)?.saved === true,
      )
      .map((event) => event.sequence),
  );
  return events.filter(
    (event) =>
      visible.includes(event.visibility) ||
      (player.role === ROLES.WITCH &&
        event.visibility === VISIBILITY_TYPES.WOLF_KILL &&
        event.sequence < antidoteSequence &&
        event.day !== null &&
        (player.deathDay === null || event.day <= player.deathDay)),
  );
}
