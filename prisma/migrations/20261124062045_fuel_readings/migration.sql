-- AlterTable
ALTER TABLE "FuelRequest" ADD COLUMN     "driverHours" DECIMAL(10,1),
ADD COLUMN     "driverOdometer" DECIMAL(12,1),
ADD COLUMN     "fillDashPhoto" TEXT,
ADD COLUMN     "odoPhoto" TEXT;

-- Requests made before: the hours on the request are the best record of what the driver typed.
UPDATE "FuelRequest" SET "driverHours" = "engineHours";
