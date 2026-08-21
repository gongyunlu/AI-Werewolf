-- DropTable
DROP TABLE "model_calls";

-- AlterTable
ALTER TABLE "games" DROP COLUMN "total_cost",
DROP COLUMN "total_tokens";

-- AlterTable
ALTER TABLE "game_summaries" DROP COLUMN "total_model_calls",
DROP COLUMN "total_tokens",
DROP COLUMN "total_cost";
