import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, weakSecret } from "@/lib/http";

export const dynamic = "force-dynamic";

// deploy/deploy.sh counts a new release as live once this answers 200. Every table is read with every column the code
// expects; the keys match no row, so no data is read. A missing migration or no database throws: 500, and the deploy
// rolls back. So does a SESSION_SECRET the session code refuses (same rule as secret() in src/lib/session.ts): every
// signed-in page would throw. In production also an unset or weak CRON_SECRET / EXPRESS_SYNC_SECRET (bearerOk refuses
// them): cron, the backup / deploy alerts and the office PC would get 401 with nobody told. The error names the
// variable, never its value (PM2 log). EXPORT_SECRET is optional (unset or weak = export off, the Office home page says
// so). Keyed by model: a model added to the schema without its line here does not compile.
// Public: it tells nothing but ok.
const tables: Record<Prisma.ModelName, () => Promise<unknown>> = {
  User: () => prisma.user.findUnique({ where: { id: "" } }),
  Vehicle: () => prisma.vehicle.findUnique({ where: { id: "" } }),
  Attendance: () => prisma.attendance.findUnique({ where: { id: "" } }),
  FuelRequest: () => prisma.fuelRequest.findUnique({ where: { id: "" } }),
  RepairRequest: () => prisma.repairRequest.findUnique({ where: { id: "" } }),
  ExpressOrder: () => prisma.expressOrder.findUnique({ where: { id: "" } }),
  AppSetting: () => prisma.appSetting.findUnique({ where: { key: "" } }),
};

export async function GET() {
  const s = process.env.SESSION_SECRET ?? "";
  if (s.length < 16 || weakSecret(s)) throw new Error("SESSION_SECRET is refused by the session code");
  if (process.env.NODE_ENV === "production")
    for (const k of ["CRON_SECRET", "EXPRESS_SYNC_SECRET"]) {
      const v = process.env[k] ?? "";
      if (!v || weakSecret(v)) throw new Error(`${k} is unset or refused (16+ characters, no placeholder, no dev- value)`);
    }
  await Promise.all(Object.values(tables).map((read) => read()));
  return ok();
}
