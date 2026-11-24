// Role-based rich menus of the LINE OA (flowchart: "Rich Menu ตามบทบาท").
//
//   node scripts/richmenu.mjs --images                 draw deploy/richmenu/<menu>.png (needs a Thai font:
//                                                      run on Windows, the PNGs are committed)
//   node --env-file=.env scripts/richmenu.mjs          create the menus through the Messaging API
//                                                      (LIFF_ID + LINE_CHANNEL_ID / LINE_CHANNEL_SECRET, or
//                                                      LINE_CHANNEL_ACCESS_TOKEN), make "guest" the
//                                                      default menu, link every active user to their role's menu
//                                                      and print the LINE_RICHMENU_<ROLE>=... lines for .env
//
// Menus made by an earlier run (name "nukyok-...") are deleted first, so it can be re-run.
// Menus made in LINE OA Manager cannot be linked per user, hence the API.
import { readFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, "..", "deploy", "richmenu");

// Tile colours: the flowchart legend.
const C = {
  blue: ["#EAF5FF", "#3DADFF"],
  yellow: ["#FFF6DE", "#FFC943"],
  pink: ["#FDEBF5", "#F849C1"],
  purple: ["#F0E9FF", "#874FFF"],
  green: ["#CDF4D3", "#66D575"],
  gray: ["#F2F2F0", "#9A9A9A"],
};

// One row of tiles (2500 x 843), or two rows when more than 4 (2500 x 1686).
// Labels: "\n" splits the line on the tile.
export const MENUS = {
  guest: [["เข้าระบบ / ลงทะเบียน", "/", "gray"]],
  driver: [
    ["เข้างาน\nออกงาน", "/driver/attendance", "blue"],
    ["ขอเติม\nน้ำมัน", "/driver/fuel", "yellow"],
    ["แจ้งซ่อม", "/driver/repair", "pink"],
    ["ของฉัน\nตรวจรับรถ", "/driver/my", "gray"],
  ],
  filler: [
    ["รายการ\nรอเติมน้ำมัน", "/filler", "yellow"],
    ["หน้าหลัก", "/", "gray"],
  ],
  office: [
    ["ตรวจ\nน้ำมัน", "/office/fuel", "yellow"],
    ["งานซ่อม", "/purchasing/repairs", "pink"],
    ["รีพอร์ต\nเข้างาน / ออกงาน", "/office/attendance", "blue"],
    ["ข้อมูลรถ\nสินทรัพย์", "/office/vehicles", "purple"],
    ["Dashboard\nต้นทุนต่อคัน", "/office/costs", "purple"],
    ["ผู้ใช้\nอนุมัติบทบาท", "/office/users", "gray"],
  ],
  exec: [
    ["อนุมัติ\nงานซ่อม", "/exec/repairs", "pink"],
    ["ตรวจ\nน้ำมัน", "/office/fuel", "yellow"],
    ["Dashboard\nต้นทุน", "/office/costs", "purple"],
    ["รีพอร์ต\nเข้างาน", "/office/attendance", "blue"],
  ],
  purchasing: [
    ["งานซ่อม\nใบเสนอราคา / ค่าซ่อม", "/purchasing/repairs", "pink"],
    ["ข้อมูลรถ", "/office/vehicles", "purple"],
    ["หน้าหลัก", "/", "gray"],
  ],
  accounting: [
    ["Dashboard\nต้นทุน", "/office/costs", "purple"],
    ["Express\nPK / PO / H3 / R3", "/office/express", "green"],
    ["ตรวจ\nน้ำมัน", "/office/fuel", "yellow"],
    ["งานซ่อม", "/purchasing/repairs", "pink"],
  ],
};

// Tile rectangles for a menu: shared by the picture and the tap areas.
export function layout(tiles) {
  const rows = tiles.length > 4 ? 2 : 1;
  const perRow = Math.ceil(tiles.length / rows);
  const width = 2500, height = 843 * rows;
  return {
    width,
    height,
    boxes: tiles.map((_, i) => {
      const r = Math.floor(i / perRow), c = i % perRow;
      const x = Math.round((c * width) / perRow), x2 = Math.round(((c + 1) * width) / perRow);
      return { x, y: r * 843, width: x2 - x, height: 843 };
    }),
  };
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Width in "characters": Thai vowel / tone marks above and below take no width.
const visible = (s) => s.replace(/[ัิ-ฺ็-๎]/g, "").length;

async function drawImages() {
  const sharp = (await import("sharp")).default;
  mkdirSync(DIR, { recursive: true });
  for (const [name, tiles] of Object.entries(MENUS)) {
    const { width, height, boxes } = layout(tiles);
    const parts = tiles.map(([label, , color], i) => {
      const b = boxes[i];
      const [fill, stroke] = C[color];
      const lines = label.split("\n");
      // each line as big as fits: about 0.6 em per character in a bold Thai font, 120 px margin
      const sizes = lines.map((l) => Math.min(110, Math.floor((b.width - 120) / (0.6 * visible(l)))));
      const block = sizes.reduce((s, z) => s + z * 1.25, 0);
      let y = b.y + (b.height - block) / 2;
      return (
        `<rect x="${b.x + 14}" y="${b.y + 14}" width="${b.width - 28}" height="${b.height - 28}" rx="48" fill="${fill}" stroke="${stroke}" stroke-width="10"/>` +
        lines
          .map((l, j) => {
            y += sizes[j] * 1.25;
            return `<text x="${b.x + b.width / 2}" y="${y - sizes[j] * 0.35}" font-size="${sizes[j]}" font-weight="bold" text-anchor="middle" fill="#1e1e1e" font-family="Leelawadee UI, Tahoma, sans-serif">${esc(l)}</text>`;
          })
          .join("")
      );
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join("")}</svg>`;
    const out = path.join(DIR, `${name}.png`);
    const info = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toFile(out);
    console.log(out, `${info.width}x${info.height}`, `${Math.round(info.size / 1024)} KB`);
  }
}

// Long-lived token when set, else a stateless 15-minute one from the channel id + secret (as src/lib/line.ts).
let bearer = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
async function token() {
  if (bearer) return bearer;
  const id = process.env.LINE_CHANNEL_ID, secret = process.env.LINE_CHANNEL_SECRET;
  if (!id || !secret) return "";
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  return (bearer = (await r.json()).access_token);
}

async function api(method, url, body, type = "application/json") {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": type } : {}) },
    ...(body ? { body: type === "application/json" ? JSON.stringify(body) : body } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function createMenus() {
  const liff = process.env.LIFF_ID;
  if (!liff || !(await token())) throw new Error("ต้องตั้ง LIFF_ID และ LINE_CHANNEL_ID + LINE_CHANNEL_SECRET (หรือ LINE_CHANNEL_ACCESS_TOKEN)");
  const { richmenus = [] } = await api("GET", "https://api.line.me/v2/bot/richmenu/list");
  for (const m of richmenus.filter((m) => m.name.startsWith("nukyok-"))) await api("DELETE", `https://api.line.me/v2/bot/richmenu/${m.richMenuId}`);

  const ids = {};
  for (const [name, tiles] of Object.entries(MENUS)) {
    const { width, height, boxes } = layout(tiles);
    const { richMenuId } = await api("POST", "https://api.line.me/v2/bot/richmenu", {
      size: { width, height },
      selected: true,
      name: `nukyok-${name}`,
      chatBarText: "เมนู",
      areas: tiles.map(([label, p], i) => ({
        bounds: boxes[i],
        action: { type: "uri", label: Array.from(label.replace(/\n/g, " ")).slice(0, 20).join(""), uri: `https://liff.line.me/${liff}${p === "/" ? "" : p}` },
      })),
    });
    await api("POST", `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, readFileSync(path.join(DIR, `${name}.png`)), "image/png");
    ids[name] = richMenuId;
  }
  // Everyone without a role menu (new / pending users) sees "guest".
  await api("POST", `https://api.line.me/v2/bot/user/all/richmenu/${ids.guest}`);

  // People already approved get their role's menu now (the web links it on each approval / role change).
  let linked = 0;
  if (process.env.DATABASE_URL) {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    for (const u of await db.user.findMany({ where: { status: "active" }, select: { lineUserId: true, roles: true } })) {
      const role = u.roles.find((r) => ids[r]);
      if (!role || u.lineUserId.startsWith("dev-")) continue;
      await api("POST", `https://api.line.me/v2/bot/user/${encodeURIComponent(u.lineUserId)}/richmenu/${ids[role]}`);
      linked++;
    }
    await db.$disconnect();
  }
  console.log(`# rich menus made, ${linked} user(s) linked. Put these in .env, then pm2 restart nukyok-web:`);
  for (const [name, id] of Object.entries(ids)) if (name !== "guest") console.log(`LINE_RICHMENU_${name.toUpperCase()}="${id}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes("--images") ? drawImages() : createMenus()).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
