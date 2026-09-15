import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from 'dotenv';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

const executeFile = promisify(execFile);
const apiDirectory = resolve(__dirname, '../..');

/** 使用正式迁移建立独立数据库，覆盖 public、langchain、触发器和扩展。 */
export async function createLearningTestDatabase(options?: {
  beforeMigration: { name: string; run: (client: Client) => Promise<void> };
}) {
  config({ path: resolve(apiDirectory, '../..', '.env.local'), quiet: true });
  config({ path: resolve(apiDirectory, '../..', '.env'), quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('集成测试需要 DATABASE_URL');
  const databaseName = 'werewolf_test_' + randomUUID().replaceAll('-', '');
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = '/' + databaseName;
  target.searchParams.delete('schema');
  const connectionString = target.toString();
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  let created = false;
  let isolated: Client | undefined;
  let db: PrismaClient | undefined;

  const runPrisma = async (...args: string[]) => {
    await executeFile(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: connectionString },
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  };
  const close = async () => {
    try {
      await db?.$disconnect();
      await isolated?.end();
      if (created) {
        if (!/^werewolf_test_[a-f0-9]{32}$/.test(databaseName))
          throw new Error('拒绝清理非测试数据库');
        await admin.query('DROP DATABASE "' + databaseName + '"');
        created = false;
      }
    } finally {
      await admin.end();
    }
  };

  try {
    await admin.query('CREATE DATABASE "' + databaseName + '"');
    created = true;
    isolated = new Client({ connectionString });
    await isolated.connect();
    if (options?.beforeMigration) {
      // 复制原始迁移到临时目录，先应用指定迁移之前的版本，再放入历史测试数据。
      const migrations = resolve(apiDirectory, 'prisma/migrations');
      const names = (await readdir(migrations)).toSorted();
      const boundary = names.indexOf(options.beforeMigration.name);
      if (boundary < 0) throw new Error('未找到迁移兼容性测试指定的迁移');
      const temporary = await mkdtemp(resolve(apiDirectory, 'test/.migration-'));
      if (!temporary.startsWith(resolve(apiDirectory, 'test/.migration-')))
        throw new Error('拒绝清理测试目录之外的迁移副本');
      try {
        for (const name of [...names.slice(0, boundary), 'migration_lock.toml'])
          await cp(resolve(migrations, name), resolve(temporary, 'migrations', name), {
            recursive: true,
          });
        const configPath = resolve(temporary, 'prisma.config.ts');
        const migrationConfig = {
          schema: resolve(apiDirectory, 'prisma/schema.prisma'),
          migrations: { path: resolve(temporary, 'migrations') },
        };
        await writeFile(
          configPath,
          `import { defineConfig } from 'prisma/config';\nexport default defineConfig({ ...${JSON.stringify(migrationConfig)}, datasource: { url: process.env.DATABASE_URL } });\n`,
        );
        await runPrisma('migrate', 'deploy', '--config', configPath);
        await options.beforeMigration.run(isolated);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    await runPrisma('migrate', 'deploy');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    await db.$connect();
    const [identity] = await db.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database()::text AS name`;
    if (identity.name !== databaseName) throw new Error('集成测试数据库隔离失败');

    return {
      db,
      databaseName,
      connectionString,
      runPrisma,
      async reset() {
        const tables = await isolated!.query<{ qualified_name: string }>(
          "SELECT format('%I.%I', schemaname, tablename) AS qualified_name FROM pg_tables " +
            "WHERE schemaname IN ('public', 'langchain') AND tablename <> '_prisma_migrations'",
        );
        if (tables.rows.length)
          await isolated!.query(
            'TRUNCATE ' + tables.rows.map((row) => row.qualified_name).join(', '),
          );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
