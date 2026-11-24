// Local Postgres for development, no system install: drives the binaries that
// the embedded-postgres package downloaded. `npm run db:dev` once; the server
// then stays up (detached) on port 5434, data in var/pg.
//   stop: node scripts/dev-db.mjs stop
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

const BIN = path.resolve("node_modules/@embedded-postgres/windows-x64/native/bin");
const DATA = path.resolve("var/pg");
const PORT = 5434;
const exe = (n) => path.join(BIN, process.platform === "win32" ? `${n}.exe` : n);

if (process.argv[2] === "stop") {
  execFileSync(exe("pg_ctl"), ["-D", DATA, "stop"], { stdio: "inherit" });
  process.exit(0);
}
if (!existsSync(path.join(DATA, "PG_VERSION"))) {
  execFileSync(exe("initdb"), ["-D", DATA, "-U", "dev", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdio: "inherit" });
}
try {
  execFileSync(exe("pg_ctl"), ["-D", DATA, "-l", path.join(DATA, "..", "pg.log"), "-o", `-p ${PORT}`, "-w", "start"], { stdio: "ignore" });
} catch {
  console.log("[dev-db] already running?  see var/pg.log");
}
console.log(`[dev-db] DATABASE_URL="postgresql://dev@localhost:${PORT}/nukyok?schema=public"`);
