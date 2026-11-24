import "server-only";
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import sharp from "sharp";
import { bkkDateKey } from "./time";

// Private files on the local disk (UPLOAD_DIR), served only to signed-in users
// by /api/files/<key>. Keys look like "fuel-dash/2026-11/<uuid>.jpg".
const ROOT = path.resolve(process.env.UPLOAD_DIR || "var/uploads");
const MAX_BYTES = 15 * 1024 * 1024;
const KEY = /^[a-z0-9-]+\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|pdf)$/;

export class UploadError extends Error {}

// Photos are re-encoded to JPEG (max 1600 px, EXIF rotation applied, metadata
// dropped); PDFs are kept as they are; anything else is refused.
export async function saveUpload(file: File, folder: string, opts: { pdf?: boolean } = {}): Promise<string> {
  if (!file.size) throw new UploadError("ไฟล์ว่าง");
  if (file.size > MAX_BYTES) throw new UploadError("ไฟล์ใหญ่เกิน 15 MB");
  const buf = Buffer.from(await file.arrayBuffer());
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (isPdf && !opts.pdf) throw new UploadError("ต้องเป็นรูปภาพ");
  let out = buf, ext = "pdf";
  if (!isPdf) {
    try {
      out = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      ext = "jpg";
    } catch {
      throw new UploadError(opts.pdf ? "ไฟล์ต้องเป็นรูปภาพหรือ PDF" : "ไฟล์ต้องเป็นรูปภาพ");
    }
  }
  const key = `${folder}/${bkkDateKey().slice(0, 7)}/${randomUUID()}.${ext}`;
  const full = path.join(ROOT, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, out);
  return key;
}

export async function readUpload(key: string): Promise<{ body: Buffer; type: string } | null> {
  if (!KEY.test(key)) return null;
  try {
    return { body: await readFile(path.join(ROOT, key)), type: key.endsWith(".pdf") ? "application/pdf" : "image/jpeg" };
  } catch {
    return null;
  }
}

export { fileUrl } from "./storage-url";
