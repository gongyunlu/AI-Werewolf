import { z } from 'zod';

// 阵营枚举
export const FACTIONS = {
  VILLAGER: 'villager',
  WEREWOLF: 'werewolf',
  THIRD_PARTY: 'third_party',
} as const;

export type Faction = typeof FACTIONS[keyof typeof FACTIONS];

const FACTIONS_ARRAY = Object.values(FACTIONS);
export const FactionSchema = z.enum(FACTIONS_ARRAY as [string, ...string[]]);
