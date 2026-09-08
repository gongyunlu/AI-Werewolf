-- AlterTable
ALTER TABLE "decision_judgments" ADD COLUMN     "evaluation_run_id" VARCHAR(200);

-- AlterTable
ALTER TABLE "team_judgments" ADD COLUMN     "evaluation_run_id" VARCHAR(200);

-- CreateTable
CREATE TABLE "evaluation_runs" (
    "id" VARCHAR(200) NOT NULL,
    "game_id" UUID NOT NULL,
    "expected_event_ids" UUID[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluation_runs_game_id_created_at_idx" ON "evaluation_runs"("game_id", "created_at");
