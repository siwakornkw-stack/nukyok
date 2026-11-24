-- AlterTable
ALTER TABLE "RepairRequest" ADD COLUMN     "endNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "endedBy" TEXT;
