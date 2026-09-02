-- 精确关联一次记忆注入与随后产生的行为事件。
-- 旧数据保留 NULL，backfillRewards 仍以保守的旧键兼容；新数据全部走 event_id。
ALTER TABLE "memory_usages" ADD COLUMN "event_id" UUID;

CREATE INDEX "memory_usages_event_id_idx" ON "memory_usages"("event_id");

CREATE UNIQUE INDEX "memory_usages_memory_id_event_id_key"
ON "memory_usages"("memory_id", "event_id");

ALTER TABLE "memory_usages"
ADD CONSTRAINT "memory_usages_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "events"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
