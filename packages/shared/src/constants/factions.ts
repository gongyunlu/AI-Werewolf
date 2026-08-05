import { z } from 'zod';

// 阵营枚举
export const FACTIONS = ['villager', 'werewolf', 'third_party'] as const;
export type Faction = (typeof FACTIONS)[number];
export const FactionSchema = z.enum(FACTIONS);
