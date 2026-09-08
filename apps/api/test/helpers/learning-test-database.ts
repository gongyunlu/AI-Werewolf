import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

const TABLES = [
  'rulesets',
  'agents',
  'games',
  'players',
  'events',
  'memories',
  'memory_usages',
  'memory_derivations',
  'global_memories',
  'pattern_candidates',
  'decision_judgments',
  'agent_performances',
  'game_summaries',
  'agent_judgments',
  'speech_summaries',
  'team_judgments',
  'knowledge_chunks',
  'knowledge_usages',
];

/** 复制表结构、索引、CHECK 和外键；所有写入与清理都限定在本次随机 schema。 */
export async function createLearningTestDatabase() {
  config({ path: resolve(__dirname, '../../../..', '.env.local'), quiet: true });
  config({ path: resolve(__dirname, '../../../..', '.env'), quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('集成测试需要 DATABASE_URL');
  const schema = 'memory_test_' + randomUUID().replaceAll('-', '');
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const drop = async () => {
    if (!/^memory_test_[a-f0-9]{32}$/.test(schema)) throw new Error('拒绝清理非测试 schema');
    await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await admin.end();
  };
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    for (const table of TABLES) {
      await admin.query(
        'CREATE TABLE "' + schema + '"."' + table + '" (LIKE public."' + table + '" INCLUDING ALL)',
      );
    }
    const constraints = await admin.query<{ table_name: string; name: string; definition: string }>(
      "SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND con.contype='f' AND c.relname=ANY($1::text[])",
      [TABLES],
    );
    for (const row of constraints.rows) {
      const definition = row.definition.replace(
        /REFERENCES (?:public\.)?("?\w+"?)/,
        'REFERENCES "' + schema + '".$1',
      );
      await admin.query(
        'ALTER TABLE "' +
          schema +
          '"."' +
          row.table_name +
          '" ADD CONSTRAINT "' +
          row.name +
          '" ' +
          definition,
      );
    }
    const db = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: process.env.DATABASE_URL,
          options: '-c search_path=' + schema + ',public',
        },
        { schema },
      ),
    });
    await db.$connect();
    return {
      db,
      async reset() {
        await admin.query(
          'TRUNCATE ' + TABLES.map((t) => '"' + schema + '"."' + t + '"').join(', '),
        );
      },
      async close() {
        await db.$disconnect();
        await drop();
      },
    };
  } catch (error) {
    await drop();
    throw error;
  }
}
