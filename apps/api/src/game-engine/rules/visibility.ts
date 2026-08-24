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
