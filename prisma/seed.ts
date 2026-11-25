// Dev data for local testing (DEV_LOGIN=1): one user per role and a few vehicles.
// Safe to re-run. Not for production: real users come in through LINE. Active fake users of every role would join
// every role's LINE notifications, so it refuses to run unless DEV_LOGIN=1, outside production, on a database of
// this machine (the server's own database is local too: its DEV_LOGIN=0 is what stops it there). Both values come from
// the environment or the project's .env, which @prisma/client loads on import (not loaded = refused).
import { PrismaClient } from "@prisma/client";

let host = "";
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {}
if (process.env.DEV_LOGIN !== "1" || process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
  console.error(`seed refused: only for a dev database on this machine with DEV_LOGIN=1 (DEV_LOGIN=${process.env.DEV_LOGIN ?? ""}, NODE_ENV=${process.env.NODE_ENV ?? ""}, host ${host || "?"})`);
  process.exit(1);
}

const prisma = new PrismaClient();

const users = [
  { lineUserId: "dev-office", name: "สมศรี Office", roles: ["office"] },
  { lineUserId: "dev-driver", name: "สมชาย คนขับ", roles: ["driver"] },
  { lineUserId: "dev-driver2", name: "สมปอง คนขับ", roles: ["driver"] },
  { lineUserId: "dev-filler", name: "สมหมาย คนเติม", roles: ["filler"] },
  { lineUserId: "dev-exec", name: "ผู้บริหาร ทดสอบ", roles: ["exec"] },
  { lineUserId: "dev-purchasing", name: "จัดซื้อ ทดสอบ", roles: ["purchasing"] },
  { lineUserId: "dev-accounting", name: "บัญชี ทดสอบ", roles: ["accounting"] },
];

const vehicles = [
  { code: "SY140-01", model: "SANY SY140", litersPerHour: 12, tankLiters: 230, pmEveryHours: 500, pmLastHours: 1000 },
  { code: "SY55-02", model: "SANY SY55", litersPerHour: 5, tankLiters: 110, pmEveryHours: 250, pmLastHours: 400 },
  { code: "70-1826", model: "รถบรรทุก 10 ล้อ", litersPerHour: 8, tankLiters: 200, pmEveryHours: 300, pmLastHours: 0 },
];

async function main() {
  for (const u of users) {
    await prisma.user.upsert({
      where: { lineUserId: u.lineUserId },
      update: {},
      create: { ...u, displayName: u.name, status: "active", approvedBy: "seed", approvedAt: new Date() },
    });
  }
  await prisma.user.upsert({
    where: { lineUserId: "dev-new" },
    update: {},
    create: { lineUserId: "dev-new", displayName: "ผู้สมัครใหม่", name: "", roles: [], status: "pending" },
  });
  for (const v of vehicles) await prisma.vehicle.upsert({ where: { code: v.code }, update: {}, create: v });
  console.log("seeded", users.length + 1, "users,", vehicles.length, "vehicles");
}

main().finally(() => prisma.$disconnect());
