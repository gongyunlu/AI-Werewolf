-- CreateTable
CREATE TABLE "graph_checkpoints" (
    "game_id" UUID NOT NULL,
    "checkpoint_ns" VARCHAR(200) NOT NULL DEFAULT '',
    "checkpoint_id" VARCHAR(120) NOT NULL,
    "parent_checkpoint_id" VARCHAR(120),
    "checkpoint" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_checkpoints_pkey" PRIMARY KEY ("game_id","checkpoint_ns","checkpoint_id")
);

-- CreateTable
CREATE TABLE "graph_checkpoint_writes" (
    "game_id" UUID NOT NULL,
    "checkpoint_ns" VARCHAR(200) NOT NULL DEFAULT '',
    "checkpoint_id" VARCHAR(120) NOT NULL,
    "task_id" VARCHAR(120) NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "graph_checkpoint_writes_pkey" PRIMARY KEY ("game_id","checkpoint_ns","checkpoint_id","task_id","idx")
);

-- AddForeignKey
ALTER TABLE "graph_checkpoints" ADD CONSTRAINT "graph_checkpoints_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_checkpoint_writes" ADD CONSTRAINT "graph_checkpoint_writes_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
