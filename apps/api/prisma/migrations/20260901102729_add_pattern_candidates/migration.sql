-- AlterTable
ALTER TABLE "global_memories" ADD COLUMN     "source_game_ids" JSONB;

-- CreateTable
CREATE TABLE "pattern_candidates" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "title" VARCHAR(256) NOT NULL,
    "content" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "source_game_ids" JSONB NOT NULL,
    "promoted_at" TIMESTAMPTZ,
    "embedding" vector(2048),
    "embedding_model" VARCHAR(128),
    "embedding_dimension" INTEGER,
    "embedding_content_hash" CHAR(64),
    "embedded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pattern_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pattern_candidates_promoted_at_idx" ON "pattern_candidates"("promoted_at");

-- AddForeignKey
ALTER TABLE "pattern_candidates" ADD CONSTRAINT "pattern_candidates_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
