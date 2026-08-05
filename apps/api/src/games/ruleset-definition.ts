import { FactionSchema } from '@ai-werewolf/shared';
import { z } from 'zod';

// Ruleset.definition 结构约定
export const RulesetDefinitionSchema = z.object({
  roles: z
    .array(
      z.object({
        role: z.string().min(1),
        faction: FactionSchema,
      }),
    )
    .min(1),
});

export type RulesetDefinition = z.infer<typeof RulesetDefinitionSchema>;
export type RoleAssignment = RulesetDefinition['roles'][number];
