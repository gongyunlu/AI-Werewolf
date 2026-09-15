-- CreateTable
CREATE TABLE "event_delivery_outbox" (
    "delivery_key" VARCHAR(350) NOT NULL,
    "game_id" UUID NOT NULL,
    "batch_key" VARCHAR(300),
    "event_ids" UUID[],
    "first_sequence" INTEGER NOT NULL,
    "last_sequence" INTEGER NOT NULL,
    "player_deaths" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_delivery_outbox_pkey" PRIMARY KEY ("delivery_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_delivery_outbox_batch_key_key" ON "event_delivery_outbox"("batch_key");

-- CreateIndex
CREATE INDEX "event_delivery_outbox_delivered_at_next_attempt_at_idx" ON "event_delivery_outbox"("delivered_at", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_delivery_outbox_game_id_first_sequence_key" ON "event_delivery_outbox"("game_id", "first_sequence");

-- AddForeignKey
ALTER TABLE "event_delivery_outbox" ADD CONSTRAINT "event_delivery_outbox_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
