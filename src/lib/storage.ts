import "server-only";
import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import sharp, { type Metadata } from "sharp";
import { bkkDateKey } from "./time";

// Private files on the local disk (UPLOAD_DIR), served only to signed-in users
// by /api/files/<key>. Keys look like "fuel-dash/2026-11/<uuid>.jpg". Folders 0700, files 0600 (owner only).
const MAX_BYTES = 15 * 1024 * 1024;
const KEY = /^[a-z0-9-]+\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|pdf)$/;

// Photo memory: a file of a few KB can make libvips decode gigabytes, and PM2 restarts the app above 600 MB.
// Only JPEG, PNG and WebP reach libvips, told apart by their first bytes (just reading the header of a 14 MB SVG
// takes 570 MB; GIF, TIFF and AVIF are decoded whole). A baseline JPEG, what phone cameras make, is read a few
// lines at a time and shrunk while it loads (a 50 MP photo costs about 50 MB), so it may have up to 100 MP.
// libvips holds the others whole while converting: every 16-bit DCT coefficient of a progressive or multi-scan JPEG
// (1.5 samples a pixel with 4:2:0 colour), every pixel of a PNG or WebP. That may be at most 64 MB, and one
// conversion runs at a time (convertQueue).
const IMAGE = /^(\xff\xd8\xff|\x89PNG\r\n\x1a\n|RIFF[\s\S]{4}WEBP)/;
const JPEG_PIXELS = 100_000_000;
const HELD_BYTES = 64 * 1024 * 1024;
let convertQueue: Promise<unknown> = Promise.resolve();
// No libvips operation cache: no two uploads are the same file, and the cache kept every decoder alive (eight
// 130 KB progressive JPEGs in a row held 550 MB).
sharp.cache(false);

// Most pixels a photo with this header may have; 0 = a format that is not taken.
export function maxPixels(m: Pick<Metadata, "format" | "isProgressive" | "channels" | "chromaSubsampling" | "depth">): number {
  if (m.format === "jpeg") return m.isProgressive ? Math.floor(HELD_BYTES / (m.chromaSubsampling === "4:2:0" ? 3 : m.channels * 2)) : JPEG_PIXELS;
  if (m.format === "png") return Math.floor(HELD_BYTES / (m.channels * (m.depth === "ushort" ? 2 : 1)));
  if (m.format === "webp") return Math.floor(HELD_BYTES / 4); // lossless WebP is decoded at 4 bytes a pixel
  return 0;
}

export class UploadError extends Error {}

// UPLOAD_DIR as an absolute path. Production refuses an unset or relative one: it would land inside the release
// folder that deploy.sh replaces and prunes, which backup-db.sh never copies.
function root(): string {
  const dir = process.env.UPLOAD_DIR || "var/uploads";
  if (process.env.NODE_ENV === "production" && !path.isAbsolute(dir))
    throw new Error(`UPLOAD_DIR must be an absolute path in production (now: ${process.env.UPLOAD_DIR || "not set"}); no file is saved or read until it is`);
  return path.resolve(dir);
}

// Photos are re-encoded to JPEG (max 1600 px, EXIF rotation applied, metadata
// dropped); PDFs are kept as they are; anything else is refused.
export async function saveUpload(file: File, folder: string, opts: { pdf?: boolean } = {}): Promise<string> {
  if (!file.size) throw new UploadError("ไฟล์ว่าง");
  if (file.size > MAX_BYTES) throw new UploadError("ไฟล์ใหญ่เกิน 15 MB");
  const dir = root();
  const buf = Buffer.from(await file.arrayBuffer());
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf && !opts.pdf) throw new UploadError("ต้องเป็นรูปภาพ");
  let out = buf, ext = "pdf";
  if (!isPdf) {
    const notImage = opts.pdf ? "ไฟล์ต้องเป็นรูป JPEG, PNG, WebP หรือ PDF" : "ไฟล์ต้องเป็นรูป JPEG, PNG หรือ WebP";
    const meta = IMAGE.test(buf.subarray(0, 12).toString("latin1")) ? await sharp(buf).metadata().catch(() => null) : null; // header only
    const max = meta ? maxPixels(meta) : 0;
    if (!meta || !max) throw new UploadError(notImage);
    if (meta.width * meta.height > max) throw new UploadError("รูปใหญ่เกินไป ถ่ายใหม่ด้วยความละเอียดปกติหรือย่อรูปก่อนส่ง");
    const job = convertQueue.then(() =>
      sharp(buf, { limitInputPixels: max })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
    );
    convertQueue = job.catch(() => undefined);
    try {
      out = await job;
      ext = "jpg";
    } catch {
      throw new UploadError(notImage);
    }
  }
  const key = `${folder}/${bkkDateKey().slice(0, 7)}/${randomUUID()}.${ext}`;
  const full = path.join(dir, key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, out, { mode: 0o600 });
  return key;
}

export async function readUpload(key: string): Promise<{ body: Buffer; type: string } | null> {
  if (!KEY.test(key)) return null;
  const dir = root();
  try {
    return { body: await readFile(path.join(dir, key)), type: key.endsWith(".pdf") ? "application/pdf" : "image/jpeg" };
  } catch {
    return null;
  }
}

// Takes back a file saved for a request that was then refused or failed, so no photo is kept without a row
// pointing to it. Never throws: a file left behind is only clutter.
export async function removeUpload(key: string): Promise<void> {
  if (!KEY.test(key)) return;
  try {
    await rm(path.join(root(), key), { force: true });
  } catch (e) {
    console.error("removeUpload", key, e);
  }
}

export { fileUrl } from "./storage-url";
