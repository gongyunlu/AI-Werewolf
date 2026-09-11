-- CreateTable
CREATE TABLE "game_executions" (
    "game_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "owner" UUID,
    "initial_state" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "deadline" TIMESTAMPTZ NOT NULL,
    "heartbeat_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_executions_pkey" PRIMARY KEY ("game_id")
);

-- CreateTable
CREATE TABLE "game_execution_steps" (
    "game_id" UUID NOT NULL,
    "key" VARCHAR(240) NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_execution_steps_pkey" PRIMARY KEY ("game_id","key")
);

-- AddForeignKey
ALTER TABLE "game_executions" ADD CONSTRAINT "game_executions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_execution_steps" ADD CONSTRAINT "game_execution_steps_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "game_executions"("game_id") ON DELETE CASCADE ON UPDATE CASCADE;
