-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "preferredModelKey" TEXT;

-- AlterTable
ALTER TABLE "ModelRequest" ADD COLUMN "requestedModelKey" TEXT;
ALTER TABLE "ModelRequest" ADD COLUMN "resolvedModelKey" TEXT;
ALTER TABLE "ModelRequest" ADD COLUMN "resolvedModelLabel" TEXT;
