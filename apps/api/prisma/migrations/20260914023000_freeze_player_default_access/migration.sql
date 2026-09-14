-- 新对局同时记录默认端点的实际地址与凭证来源；不推测历史对局未记录的端点。
ALTER TABLE "players" ADD COLUMN "access_uses_default" BOOLEAN NOT NULL DEFAULT false;
