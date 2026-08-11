import type { RoleAssignment } from '@/games/ruleset-definition';

export interface RoleAndSeatAssignment {
  agentId: string;
  seatNo: number;
  role: string;
  faction: string;
}

/**
 * 为 Agent 随机分配角色和座位号
 *
 * @param roles - 角色配置列表（来自 Ruleset.definition.roles）
 * @param agentIds - Agent ID 列表
 * @returns 角色-座位-Agent 分配结果
 */
export function assignRolesAndSeats(
  roles: readonly RoleAssignment[],
  agentIds: readonly string[],
): RoleAndSeatAssignment[] {
  // Fisher-Yates 洗牌
  const shuffledRoles = shuffle(roles);
  const shuffledAgents = shuffle(agentIds);

  // 配对并分配座位号
  return shuffledAgents.map((agentId, index) => ({
    agentId,
    seatNo: index + 1,
    role: shuffledRoles[index]!.role,
    faction: shuffledRoles[index]!.faction,
  }));
}

/**
 * Fisher-Yates 洗牌算法
 */
function shuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
