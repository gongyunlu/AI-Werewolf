import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const reference = z
  .object({
    id: z.string().min(1).max(200),
    name: z.enum(['werewolf.quality', 'werewolf.verdict']),
    timestamp: z.iso.datetime({ offset: true }),
  })
  .strict();

/** 由调用方指定幂等采用 ID 和完整的行动/评分身份，服务端不会猜选最新版。 */
export class AdoptScoresDto extends createZodDto(
  z
    .object({
      runId: z.string().min(1).max(200),
      definitionRunId: z.string().min(1).max(200),
      selections: z
        .array(z.object({ eventId: z.uuid(), quality: reference, verdict: reference }).strict())
        .max(2000),
    })
    .strict(),
) {}
