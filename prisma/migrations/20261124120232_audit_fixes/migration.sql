-- AlterTable
ALTER TABLE "FuelRequest" ADD COLUMN     "invoiceDate" DATE;

-- AlterTable
ALTER TABLE "RepairRequest" ADD COLUMN     "invoiceDate" DATE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionsAfter" TIMESTAMP(3);
