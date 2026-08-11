import type { PlayerState, GameGraphState } from '../core/types';
import type { Role, Faction } from '@ai-werewolf/shared';

/**
 * 测试工具：创建玩家状态
 *
 * 支持多种调用方式：
 * 1. createPlayer({ id, seatNo, role, faction })
 * 2. createPlayer({ id, seatNo, role, faction }, { overrides })
 * 3. createPlayer(id, seatNo, { role, faction, ... })
 * 4. createPlayer(id, seatNo, isAlive)
 * 5. createPlayer(id, seatNo, role, faction, isAlive)
 */
export function createPlayer(
  idOrCore: string | { id: string; seatNo: number; role: Role; faction: Faction },
  seatNoOrOverrides?: number | Partial<PlayerState>,
  roleOrOverridesOrIsAlive?: Role | Partial<PlayerState> | boolean,
  faction?: Faction,
  isAlive?: boolean,
): PlayerState {
  // 方式1/2：对象参数
  if (typeof idOrCore === 'object') {
    const core = idOrCore;
    const overrides = seatNoOrOverrides as Partial<PlayerState> | undefined;
    return {
      ...core,
      isAlive: true,
      deathDay: null,
      deathCause: null,
      protectedByGuard: false,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      antidoteUsedOn: null,
      poisonUsedOn: null,
      ...overrides,
    };
  }

  const id = idOrCore;
  const seatNo = seatNoOrOverrides as number;

  // 方式3：createPlayer(id, seatNo, { overrides })
  if (typeof roleOrOverridesOrIsAlive === 'object') {
    const overrides = roleOrOverridesOrIsAlive as Partial<PlayerState>;
    return {
      id,
      seatNo,
      role: 'villager',
      faction: 'villager',
      isAlive: true,
      deathDay: null,
      deathCause: null,
      protectedByGuard: false,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      antidoteUsedOn: null,
      poisonUsedOn: null,
      ...overrides,
    };
  }

  // 方式4：createPlayer(id, seatNo, isAlive)
  if (typeof roleOrOverridesOrIsAlive === 'boolean') {
    return {
      id,
      seatNo,
      role: 'villager',
      faction: 'villager',
      isAlive: roleOrOverridesOrIsAlive,
      deathDay: null,
      deathCause: null,
      protectedByGuard: false,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      antidoteUsedOn: null,
      poisonUsedOn: null,
    };
  }

  // 方式5：createPlayer(id, seatNo, role, faction, isAlive)
  const role = roleOrOverridesOrIsAlive as Role;
  return {
    id,
    seatNo,
    role,
    faction: faction!,
    isAlive: isAlive ?? true,
    deathDay: null,
    deathCause: null,
    protectedByGuard: false,
    hasAntidoteUsed: false,
    hasPoisonUsed: false,
    antidoteUsedOn: null,
    poisonUsedOn: null,
  };
}

/**
 * 测试工具：创建游戏状态
 *
 * @param core 核心必填字段
 * @param overrides 可选的覆盖字段
 * @returns 完整的 GameGraphState 对象
 *
 * @example
 * const state = createGameState(
 *   { gameId: 'test-game', players: [player1, player2] },
 *   { currentDay: 2, currentPhase: 'day' }
 * );
 */
export function createGameState(
  core: {
    gameId: string;
    players: PlayerState[];
  },
  overrides?: Partial<GameGraphState>,
): GameGraphState {
  const base: GameGraphState = {
    ...core,
    currentDay: 1,
    currentPhase: 'night',
    eventSequence: 0,
    wolfTarget: null,
    witchAntidoteTarget: null,
    witchPoisonTarget: null,
    guardTarget: null,
    seerCheckTarget: null,
    exileTarget: null,
    exileVoteCount: null,
    votingResults: new Map(),
    isGameOver: false,
    winner: null,
    loverPair: null,
    nightDeaths: null,
    seerCheckResult: null,
    interrupt: null,
    nextIsDay: false,
    speechOrder: null,
    speechDirection: null,
    speechStartSeatNo: null,
    speechOrderReason: null,
    rulesetId: 'test-ruleset',
    pkCandidates: null,
    pkRound: 0,
    lastVoteResults: null,
  };

  if (!overrides) {
    return base;
  }

  // 合并 overrides，确保类型正确
  return {
    ...base,
    ...overrides,
  };
}
