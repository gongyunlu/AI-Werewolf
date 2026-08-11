-- AlterTable
ALTER TABLE "games" ALTER COLUMN "status" SET DEFAULT 'created';

-- AlterTable
ALTER TABLE "players" ALTER COLUMN "seat_no" DROP NOT NULL,
ALTER COLUMN "role" DROP NOT NULL,
ALTER COLUMN "faction" DROP NOT NULL;
