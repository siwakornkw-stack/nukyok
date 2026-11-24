// next dev on :3001 with its output also written to var/e2e/dev.log, so e2e.mjs can check every LINE
// dry-run message. LINE_CHANNEL_SECRET only signs the webhook test (no channel id = still dry-run);
// LINE_RICHMENU_DRIVER makes approving a driver link a rich menu.
import { spawn } from "child_process";
import { createWriteStream } from "fs";

const log = createWriteStream(new URL("./dev.log", import.meta.url));
const p = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3001"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LINE_CHANNEL_SECRET: "dev-line-secret", LINE_RICHMENU_DRIVER: "richmenu-dev-driver" },
});
for (const s of [p.stdout, p.stderr])
  s.on("data", (d) => {
    process.stdout.write(d);
    log.write(d);
  });
p.on("exit", (c) => process.exit(c ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => p.kill());
