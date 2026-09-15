-- AlterTable
ALTER TABLE "decision_judgments" ADD COLUMN     "source" JSONB;

-- AlterTable
ALTER TABLE "evaluation_runs" ADD COLUMN     "definition" JSONB,
ADD COLUMN     "delivered_event_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "pending_results" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "selection" JSONB;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "source" JSONB;

-- AlterTable
ALTER TABLE "team_judgments" ADD COLUMN     "source" JSONB;
