-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "requestedRole" TEXT NOT NULL DEFAULT '',
    "roles" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rememberVehicleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "litersPerHour" DECIMAL(8,2),
    "tankLiters" DECIMAL(8,2),
    "pmEveryHours" INTEGER,
    "pmLastHours" DECIMAL(10,1),
    "expressItem" TEXT NOT NULL DEFAULT '',
    "expressDep" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "inAt" TIMESTAMP(3) NOT NULL,
    "inPhoto" TEXT NOT NULL,
    "inLat" DOUBLE PRECISION,
    "inLng" DOUBLE PRECISION,
    "outAt" TIMESTAMP(3),
    "outPhoto" TEXT,
    "outLat" DOUBLE PRECISION,
    "outLng" DOUBLE PRECISION,
    "forgotAlertAt" TIMESTAMP(3),

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuelRequest" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "engineHours" DECIMAL(10,1) NOT NULL,
    "dashPhoto" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remindedAt" TIMESTAMP(3),
    "remindCount" INTEGER NOT NULL DEFAULT 0,
    "fillerId" TEXT,
    "liters" DECIMAL(10,2),
    "pricePerLiter" DECIMAL(10,4),
    "amount" DECIMAL(12,2),
    "source" TEXT,
    "supplierCode" TEXT NOT NULL DEFAULT '',
    "supplierName" TEXT NOT NULL DEFAULT '',
    "invoice" TEXT NOT NULL DEFAULT '',
    "slipPhoto" TEXT,
    "odometer" DECIMAL(12,1),
    "filledAt" TIMESTAMP(3),
    "flags" JSONB NOT NULL DEFAULT '[]',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "returnNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "FuelRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairRequest" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quote',
    "driverId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "symptom" TEXT NOT NULL,
    "cause" TEXT NOT NULL DEFAULT '',
    "odometer" DECIMAL(12,1),
    "pmRound" TEXT NOT NULL DEFAULT '',
    "photos" TEXT[],
    "urgency" TEXT NOT NULL,
    "fromPm" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quoteAmount" DECIMAL(12,2),
    "quoteNote" TEXT NOT NULL DEFAULT '',
    "quoteFiles" TEXT[],
    "quotedBy" TEXT,
    "quotedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "costAmount" DECIMAL(12,2),
    "costDetail" TEXT NOT NULL DEFAULT '',
    "billFiles" TEXT[],
    "supplierCode" TEXT NOT NULL DEFAULT '',
    "supplierName" TEXT NOT NULL DEFAULT '',
    "itemCode" TEXT NOT NULL DEFAULT '',
    "invoice" TEXT NOT NULL DEFAULT '',
    "costedBy" TEXT,
    "costedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "reopenNote" TEXT NOT NULL DEFAULT '',
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "RepairRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpressOrder" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fuelRequestId" TEXT,
    "repairRequestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "poNo" TEXT,
    "h3No" TEXT,
    "error" TEXT,
    "r3Status" TEXT,
    "r3No" TEXT,
    "r3Error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpressOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_code_key" ON "Vehicle"("code");

-- CreateIndex
CREATE INDEX "Attendance_workDate_idx" ON "Attendance"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_workDate_key" ON "Attendance"("userId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "FuelRequest_no_key" ON "FuelRequest"("no");

-- CreateIndex
CREATE INDEX "FuelRequest_status_idx" ON "FuelRequest"("status");

-- CreateIndex
CREATE INDEX "FuelRequest_vehicleId_createdAt_idx" ON "FuelRequest"("vehicleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepairRequest_no_key" ON "RepairRequest"("no");

-- CreateIndex
CREATE INDEX "RepairRequest_status_idx" ON "RepairRequest"("status");

-- CreateIndex
CREATE INDEX "RepairRequest_vehicleId_createdAt_idx" ON "RepairRequest"("vehicleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExpressOrder_fuelRequestId_key" ON "ExpressOrder"("fuelRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpressOrder_repairRequestId_key" ON "ExpressOrder"("repairRequestId");

-- CreateIndex
CREATE INDEX "ExpressOrder_kind_status_idx" ON "ExpressOrder"("kind", "status");

-- CreateIndex
CREATE INDEX "ExpressOrder_r3Status_idx" ON "ExpressOrder"("r3Status");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelRequest" ADD CONSTRAINT "FuelRequest_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelRequest" ADD CONSTRAINT "FuelRequest_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FuelRequest" ADD CONSTRAINT "FuelRequest_fillerId_fkey" FOREIGN KEY ("fillerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairRequest" ADD CONSTRAINT "RepairRequest_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairRequest" ADD CONSTRAINT "RepairRequest_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpressOrder" ADD CONSTRAINT "ExpressOrder_fuelRequestId_fkey" FOREIGN KEY ("fuelRequestId") REFERENCES "FuelRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpressOrder" ADD CONSTRAINT "ExpressOrder_repairRequestId_fkey" FOREIGN KEY ("repairRequestId") REFERENCES "RepairRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
