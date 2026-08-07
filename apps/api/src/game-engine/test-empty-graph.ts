import { GameEngine } from './game-engine';
import type { GameGraphState } from './types';

async function testEmptyGraph() {
  const engine = new GameEngine();

  // --- 场景 1：狼胜（第一夜后狼数 >= 好人数）---
  const scenario1: GameGraphState = {
    gameId: 'test-1',
    currentDay: 1,
    currentPhase: 'night',
    players: [
      {
        id: 'p1',
        seatNumber: 1,
        role: 'werewolf',
        faction: 'werewolf',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
      {
        id: 'p2',
        seatNumber: 2,
        role: 'werewolf',
        faction: 'werewolf',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
      {
        id: 'p3',
        seatNumber: 3,
        role: 'villager',
        faction: 'villager',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
      {
        id: 'p4',
        seatNumber: 4,
        role: 'villager',
        faction: 'villager',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
    ],
    eventSequence: 0,
    wolfTarget: null,
    witchAntidoteTarget: null,
    witchPoisonTarget: null,
    guardTarget: null,
    votingResults: new Map(),
    isGameOver: false,
    winner: null,
  };

  const result1 = await engine.run(scenario1);
  // eslint-disable-next-line no-console
  console.log('胜方:', result1.winner);

  // --- 场景 2：好人胜（狼人被全部放逐）---
  const scenario2: GameGraphState = {
    gameId: 'test-2',
    currentDay: 1,
    currentPhase: 'night',
    players: [
      {
        id: 'p1',
        seatNumber: 1,
        role: 'werewolf',
        faction: 'werewolf',
        isAlive: false,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      }, // 狼已死
      {
        id: 'p2',
        seatNumber: 2,
        role: 'villager',
        faction: 'villager',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
      {
        id: 'p3',
        seatNumber: 3,
        role: 'villager',
        faction: 'villager',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
      {
        id: 'p4',
        seatNumber: 4,
        role: 'villager',
        faction: 'villager',
        isAlive: true,
        protectedByGuard: false,
        hasAntidoteUsed: false,
        hasPoisonUsed: false,
      },
    ],
    eventSequence: 0,
    wolfTarget: null,
    witchAntidoteTarget: null,
    witchPoisonTarget: null,
    guardTarget: null,
    votingResults: new Map(),
    isGameOver: false,
    winner: null,
  };

  const result2 = await engine.run(scenario2);
  // eslint-disable-next-line no-console
  console.log('胜方:', result2.winner);
}

testEmptyGraph().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('测试失败:', err);
  process.exit(1);
});
