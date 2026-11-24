-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aiKeyAt" TIMESTAMP(3),
ADD COLUMN     "aiKeyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_aiKeyHash_key" ON "User"("aiKeyHash");

