-- CreateTable
CREATE TABLE "agent_judgments" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "speech_event_id" UUID NOT NULL,
    "day" SMALLINT NOT NULL,
    "speaker_seat_no" SMALLINT NOT NULL,
    "trust_score" SMALLINT NOT NULL,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "relationship" VARCHAR(20),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_judgments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_judgments_agent_game_idx" ON "agent_judgments"("agent_id", "game_id");

-- CreateIndex
CREATE INDEX "agent_judgments_day_idx" ON "agent_judgments"("game_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "agent_judgments_agent_id_speech_event_id_key" ON "agent_judgments"("agent_id", "speech_event_id");

-- AddForeignKey
ALTER TABLE "agent_judgments" ADD CONSTRAINT "agent_judgments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_judgments" ADD CONSTRAINT "agent_judgments_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_judgments" ADD CONSTRAINT "agent_judgments_speech_event_id_fkey" FOREIGN KEY ("speech_event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
