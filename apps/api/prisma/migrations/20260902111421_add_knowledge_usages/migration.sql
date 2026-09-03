-- CreateTable
CREATE TABLE "knowledge_usages" (
    "id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "event_id" UUID,
    "scenario" VARCHAR(32) NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "day" SMALLINT NOT NULL,
    "reward_score" SMALLINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_usages_chunk_id_idx" ON "knowledge_usages"("chunk_id");

-- CreateIndex
CREATE INDEX "knowledge_usages_game_id_player_id_idx" ON "knowledge_usages"("game_id", "player_id");

-- CreateIndex
CREATE INDEX "knowledge_usages_event_id_idx" ON "knowledge_usages"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_usages_chunk_id_event_id_key" ON "knowledge_usages"("chunk_id", "event_id");

-- AddForeignKey
ALTER TABLE "knowledge_usages" ADD CONSTRAINT "knowledge_usages_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "knowledge_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_usages" ADD CONSTRAINT "knowledge_usages_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_usages" ADD CONSTRAINT "knowledge_usages_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_usages" ADD CONSTRAINT "knowledge_usages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
