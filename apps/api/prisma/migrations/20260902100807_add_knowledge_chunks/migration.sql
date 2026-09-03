-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "source_file" VARCHAR(128) NOT NULL,
    "article_title" VARCHAR(256) NOT NULL,
    "section_title" VARCHAR(256),
    "role" VARCHAR(32) NOT NULL,
    "scenario" VARCHAR(32) NOT NULL,
    "trigger" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(2048),
    "embedding_model" VARCHAR(128),
    "embedding_dimension" INTEGER,
    "embedding_content_hash" CHAR(64),
    "embedded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_chunks_role_scenario_idx" ON "knowledge_chunks"("role", "scenario");
