-- CreateTable
CREATE TABLE "decision_judgments" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "action_type" VARCHAR(32) NOT NULL,
    "day" SMALLINT NOT NULL,
    "target_seat_no" SMALLINT,
    "verdict" VARCHAR(16) NOT NULL,
    "score" SMALLINT NOT NULL,
    "reasoning" TEXT,
    "model_name" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_judgments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_judgments_event_id_key" ON "decision_judgments"("event_id");

-- CreateIndex
CREATE INDEX "decision_judgments_game_id_idx" ON "decision_judgments"("game_id");

-- CreateIndex
CREATE INDEX "decision_judgments_player_id_action_type_idx" ON "decision_judgments"("player_id", "action_type");

-- AddForeignKey
ALTER TABLE "decision_judgments" ADD CONSTRAINT "decision_judgments_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_judgments" ADD CONSTRAINT "decision_judgments_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_judgments" ADD CONSTRAINT "decision_judgments_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
