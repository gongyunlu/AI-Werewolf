-- AlterTable
ALTER TABLE "events" ADD COLUMN     "effect_key" VARCHAR(300),
ADD COLUMN     "payload_hash" CHAR(64);

-- CreateTable
CREATE TABLE "effect_batch_commits" (
    "batch_key" VARCHAR(300) NOT NULL,
    "game_id" UUID NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "outcomes" JSONB NOT NULL,
    "event_ids" UUID[],
    "committed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "effect_batch_commits_pkey" PRIMARY KEY ("batch_key")
);

-- CreateIndex
CREATE INDEX "effect_batch_commits_game_id_idx" ON "effect_batch_commits"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_effect_key_key" ON "events"("effect_key");

-- AddForeignKey
ALTER TABLE "effect_batch_commits" ADD CONSTRAINT "effect_batch_commits_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
