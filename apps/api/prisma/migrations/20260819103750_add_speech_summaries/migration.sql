-- CreateTable
CREATE TABLE "speech_summaries" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "day" SMALLINT NOT NULL,
    "seat_no" SMALLINT NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speech_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "speech_summaries_game_id_day_idx" ON "speech_summaries"("game_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "speech_summaries_game_id_day_seat_no_key" ON "speech_summaries"("game_id", "day", "seat_no");

-- AddForeignKey
ALTER TABLE "speech_summaries" ADD CONSTRAINT "speech_summaries_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
