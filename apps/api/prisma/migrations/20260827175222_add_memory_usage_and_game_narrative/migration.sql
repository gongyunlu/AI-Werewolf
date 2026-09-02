-- AlterTable
ALTER TABLE "game_summaries" ADD COLUMN     "narrative" TEXT;

-- CreateTable
CREATE TABLE "memory_usages" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "scenario" VARCHAR(32) NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "day" SMALLINT NOT NULL,
    "trigger_matched" BOOLEAN NOT NULL DEFAULT false,
    "reward_score" SMALLINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_usages_memory_id_idx" ON "memory_usages"("memory_id");

-- CreateIndex
CREATE INDEX "memory_usages_game_id_player_id_idx" ON "memory_usages"("game_id", "player_id");

-- AddForeignKey
ALTER TABLE "memory_usages" ADD CONSTRAINT "memory_usages_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_usages" ADD CONSTRAINT "memory_usages_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_usages" ADD CONSTRAINT "memory_usages_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
