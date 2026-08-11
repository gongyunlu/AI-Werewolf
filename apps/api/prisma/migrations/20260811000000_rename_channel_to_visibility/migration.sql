-- AlterTable: 将 events 表的 channel 字段重命名为 visibility
ALTER TABLE "events" RENAME COLUMN "channel" TO "visibility";

-- 更新注释：说明 visibility 字段的用途
COMMENT ON COLUMN "events"."visibility" IS '事件可见性：public(所有人)/wolf(狼人)/seer(预言家)/witch(女巫)/guard(守卫)/system(系统内部)';
