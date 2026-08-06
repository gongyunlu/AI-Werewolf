import { z } from 'zod';

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  ARK_API_KEY: z.string().min(1),
  ARK_BASE_URL: z.url(),
  ARK_DEFAULT_MODEL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`环境变量校验失败: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
