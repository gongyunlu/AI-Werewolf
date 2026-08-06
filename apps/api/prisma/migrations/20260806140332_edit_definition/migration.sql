-- AlterTable
ALTER TABLE "game_summaries" ALTER COLUMN "total_cost" SET DATA TYPE DECIMAL(14,8);

-- AlterTable
ALTER TABLE "games" ALTER COLUMN "total_cost" SET DATA TYPE DECIMAL(14,8);

-- AlterTable
ALTER TABLE "model_calls" ALTER COLUMN "cost" SET DATA TYPE DECIMAL(14,8);
