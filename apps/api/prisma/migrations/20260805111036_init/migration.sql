-- CreateTable
CREATE TABLE "rulesets" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "player_count" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rulesets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "ruleset_id" VARCHAR(64) NOT NULL,
    "skill_version" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "winner_faction" VARCHAR(16),
    "total_days" INTEGER,
    "total_cost" DECIMAL(10,8),
    "total_tokens" INTEGER,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "default_model_name" VARCHAR(64) NOT NULL,
    "memory_label" VARCHAR(128) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "seat_no" SMALLINT NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "faction" VARCHAR(16) NOT NULL,
    "display_name" VARCHAR(64) NOT NULL,
    "model_name" VARCHAR(64) NOT NULL,
    "death_day" SMALLINT,
    "death_cause" VARCHAR(32),
    "is_sheriff" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "day" SMALLINT,
    "phase" VARCHAR(32) NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'public',
    "actor_id" UUID,
    "target_ids" JSONB,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_calls" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID,
    "event_id" UUID,
    "model_name" VARCHAR(128) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "request_prompt" TEXT NOT NULL,
    "response_text" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost" DECIMAL(10,8) NOT NULL,
    "latency_ms" INTEGER,
    "status" VARCHAR(32) NOT NULL DEFAULT 'success',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "label" VARCHAR(128) NOT NULL,
    "game_id" UUID,
    "event_id" UUID,
    "type" VARCHAR(32) NOT NULL,
    "title" VARCHAR(256) NOT NULL,
    "content" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "retrieval_count" INTEGER NOT NULL DEFAULT 0,
    "last_retrieved_at" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source" VARCHAR(32),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_memories" (
    "id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "title" VARCHAR(256) NOT NULL,
    "content" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "source" VARCHAR(32),
    "retrieval_count" INTEGER NOT NULL DEFAULT 0,
    "last_retrieved_at" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "global_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_performances" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "faction" VARCHAR(16) NOT NULL,
    "survival_days" SMALLINT NOT NULL,
    "death_cause" VARCHAR(32),
    "is_winner" BOOLEAN NOT NULL,
    "vote_accuracy" REAL,
    "ability_use_count" INTEGER NOT NULL DEFAULT 0,
    "speech_count" INTEGER NOT NULL DEFAULT 0,
    "speech_avg_tokens" INTEGER,
    "reflection_generated" BOOLEAN NOT NULL DEFAULT false,
    "score" REAL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_performances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_summaries" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "total_days" SMALLINT NOT NULL,
    "winner_faction" VARCHAR(16) NOT NULL,
    "villager_alive_count" SMALLINT NOT NULL,
    "werewolf_alive_count" SMALLINT NOT NULL,
    "third_party_alive_count" SMALLINT NOT NULL DEFAULT 0,
    "key_events" JSONB,
    "mvp_player_id" UUID,
    "total_speech_count" INTEGER NOT NULL,
    "total_model_calls" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "total_cost" DECIMAL(10,8) NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "players_game_id_seat_no_key" ON "players"("game_id", "seat_no");

-- CreateIndex
CREATE UNIQUE INDEX "players_game_id_agent_id_key" ON "players"("game_id", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "events_game_id_sequence_key" ON "events"("game_id", "sequence");

-- CreateIndex
CREATE INDEX "model_calls_game_id_idx" ON "model_calls"("game_id");

-- CreateIndex
CREATE INDEX "model_calls_player_id_idx" ON "model_calls"("player_id");

-- CreateIndex
CREATE INDEX "model_calls_event_id_idx" ON "model_calls"("event_id");

-- CreateIndex
CREATE INDEX "memories_agent_id_label_idx" ON "memories"("agent_id", "label");

-- CreateIndex
CREATE INDEX "memories_agent_id_type_idx" ON "memories"("agent_id", "type");

-- CreateIndex
CREATE INDEX "memories_agent_id_importance_idx" ON "memories"("agent_id", "importance");

-- CreateIndex
CREATE INDEX "memories_agent_id_last_retrieved_at_idx" ON "memories"("agent_id", "last_retrieved_at");

-- CreateIndex
CREATE INDEX "global_memories_type_idx" ON "global_memories"("type");

-- CreateIndex
CREATE INDEX "global_memories_importance_idx" ON "global_memories"("importance");

-- CreateIndex
CREATE INDEX "global_memories_last_retrieved_at_idx" ON "global_memories"("last_retrieved_at");

-- CreateIndex
CREATE INDEX "agent_performances_player_id_idx" ON "agent_performances"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_performances_game_id_player_id_key" ON "agent_performances"("game_id", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_summaries_game_id_key" ON "game_summaries"("game_id");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_ruleset_id_fkey" FOREIGN KEY ("ruleset_id") REFERENCES "rulesets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_performances" ADD CONSTRAINT "agent_performances_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_performances" ADD CONSTRAINT "agent_performances_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_summaries" ADD CONSTRAINT "game_summaries_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
