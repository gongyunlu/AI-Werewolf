-- Embeddings are derived data. Clear any legacy 2560-dimensional values before
-- aligning the physical columns with doubao-embedding-vision's 2048 dimensions.
UPDATE "memories" SET "embedding" = NULL WHERE "embedding" IS NOT NULL;
UPDATE "global_memories" SET "embedding" = NULL WHERE "embedding" IS NOT NULL;

ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector(2048);
ALTER TABLE "global_memories" ALTER COLUMN "embedding" TYPE vector(2048);

-- AlterTable
ALTER TABLE "global_memories" ADD COLUMN     "embedded_at" TIMESTAMPTZ,
ADD COLUMN     "embedding_content_hash" CHAR(64),
ADD COLUMN     "embedding_dimension" INTEGER,
ADD COLUMN     "embedding_model" VARCHAR(128),
ADD CONSTRAINT "global_memories_embedding_metadata_check" CHECK (
    ("embedding" IS NULL AND "embedded_at" IS NULL AND "embedding_content_hash" IS NULL AND "embedding_dimension" IS NULL AND "embedding_model" IS NULL)
    OR
    ("embedding" IS NOT NULL AND "embedded_at" IS NOT NULL AND "embedding_content_hash" IS NOT NULL AND "embedding_dimension" = 2048 AND "embedding_model" IS NOT NULL)
);

-- AlterTable
ALTER TABLE "memories" ADD COLUMN     "embedded_at" TIMESTAMPTZ,
ADD COLUMN     "embedding_content_hash" CHAR(64),
ADD COLUMN     "embedding_dimension" INTEGER,
ADD COLUMN     "embedding_model" VARCHAR(128),
ADD CONSTRAINT "memories_embedding_metadata_check" CHECK (
    ("embedding" IS NULL AND "embedded_at" IS NULL AND "embedding_content_hash" IS NULL AND "embedding_dimension" IS NULL AND "embedding_model" IS NULL)
    OR
    ("embedding" IS NOT NULL AND "embedded_at" IS NOT NULL AND "embedding_content_hash" IS NOT NULL AND "embedding_dimension" = 2048 AND "embedding_model" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "memory_derivations" (
    "derived_memory_id" UUID NOT NULL,
    "source_memory_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_derivations_pkey" PRIMARY KEY ("derived_memory_id","source_memory_id")
);

-- CreateIndex
CREATE INDEX "memory_derivations_source_memory_id_idx" ON "memory_derivations"("source_memory_id");

-- AddForeignKey
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_derived_memory_id_fkey" FOREIGN KEY ("derived_memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_source_memory_id_fkey" FOREIGN KEY ("source_memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A memory cannot be derived from itself.
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_no_self_reference_check" CHECK ("derived_memory_id" <> "source_memory_id");

-- Any content update invalidates its derived vector, including writes that bypass MemoryService.
CREATE FUNCTION "invalidate_memory_embedding_on_content_change"() RETURNS TRIGGER AS $$
BEGIN
    NEW."embedding" := NULL;
    NEW."embedding_model" := NULL;
    NEW."embedding_dimension" := NULL;
    NEW."embedding_content_hash" := NULL;
    NEW."embedded_at" := NULL;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "memories_invalidate_embedding_on_content_change"
BEFORE UPDATE OF "content" ON "memories"
FOR EACH ROW
WHEN (OLD."content" IS DISTINCT FROM NEW."content")
EXECUTE FUNCTION "invalidate_memory_embedding_on_content_change"();

CREATE TRIGGER "global_memories_invalidate_embedding_on_content_change"
BEFORE UPDATE OF "content" ON "global_memories"
FOR EACH ROW
WHEN (OLD."content" IS DISTINCT FROM NEW."content")
EXECUTE FUNCTION "invalidate_memory_embedding_on_content_change"();

-- Chat history DDL belongs to migration history; the application only performs DML.
CREATE SCHEMA IF NOT EXISTS "langchain";

CREATE TABLE IF NOT EXISTS "langchain"."langchain_chat_histories" (
    "id" SERIAL PRIMARY KEY,
    "session_id" VARCHAR(255) NOT NULL,
    "message" JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS "langchain_chat_histories_session_id_id_idx"
ON "langchain"."langchain_chat_histories" ("session_id", "id");
