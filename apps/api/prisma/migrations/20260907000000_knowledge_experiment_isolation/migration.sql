-- AlterTable
ALTER TABLE "decision_judgments" ADD COLUMN     "evaluation_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "previous_evaluations" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "experiment" JSONB;

-- AlterTable
ALTER TABLE "knowledge_chunks" ADD COLUMN     "applicability" JSONB,
ADD COLUMN     "source_hash" CHAR(64),
ADD COLUMN     "version" VARCHAR(64) NOT NULL DEFAULT 'legacy';

-- CreateTable
CREATE TABLE "knowledge_retrievals" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "event_id" UUID,
    "query" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_retrievals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_contexts" (
    "event_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_contexts_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "team_judgments" (
    "event_id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "faction" VARCHAR(16) NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "score" SMALLINT NOT NULL,
    "verdict" VARCHAR(16) NOT NULL,
    "reasoning" TEXT NOT NULL,
    "model_name" VARCHAR(64) NOT NULL,
    "evaluation_version" INTEGER NOT NULL,
    "previous_evaluations" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_judgments_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "knowledge_retrievals_game_id_player_id_idx" ON "knowledge_retrievals"("game_id", "player_id");

-- CreateIndex
CREATE INDEX "decision_contexts_game_id_idx" ON "decision_contexts"("game_id");

-- CreateIndex
CREATE INDEX "team_judgments_game_id_idx" ON "team_judgments"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_version_source_hash_key" ON "knowledge_chunks"("version", "source_hash");
