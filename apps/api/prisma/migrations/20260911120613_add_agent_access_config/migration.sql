-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "api_key_ciphertext" TEXT,
ADD COLUMN     "base_url" VARCHAR(512),
ADD COLUMN     "tag" VARCHAR(64);

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "access_base_url" VARCHAR(512);
