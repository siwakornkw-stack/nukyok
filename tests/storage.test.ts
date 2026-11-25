import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { crc32 } from "zlib";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { maxPixels, readUpload, removeUpload, saveUpload } from "@/lib/storage";

const MB64 = 64 * 1024 * 1024;
const TOO_BIG = "รูปใหญ่เกินไป ถ่ายใหม่ด้วยความละเอียดปกติหรือย่อรูปก่อนส่ง";

// Headers only (a few dozen bytes) that claim a huge image: refused from the header, never decoded.
function pngHeader(w: number, h: number, depth: number, colour: number, interlace: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
  ihdr[12] = interlace;
  const idat = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
function jpegHeader(w: number, h: number, sof: number): Buffer {
  const seg = (m: number, body: number[]) => Buffer.from([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
  const frame = seg(sof, [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]); // 4:2:0
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, seg(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 0, 0]), Buffer.from([0xff, 0xd9])]);
}
const file = (b: Buffer | string) => new File([typeof b === "string" ? b : new Uint8Array(b)], "a");
const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#777" } });

describe("maxPixels", () => {
  it("lets a baseline JPEG (phone camera) through up to 100 MP", () => {
    expect(maxPixels({ format: "jpeg", isProgressive: false, channels: 3, chromaSubsampling: "4:2:0", depth: "uchar" })).toBe(100_000_000);
  });

  it("caps what libvips holds whole at 64 MB: progressive JPEG coefficients, PNG and WebP pixels", () => {
    expect(maxPixels({ format: "jpeg", isProgressive: true, channels: 3, chromaSubsampling: "4:2:0", depth: "uchar" })).toBe(Math.floor(MB64 / 3));
    expect(maxPixels({ format: "jpeg", isProgressive: true, channels: 3, chromaSubsampling: "4:4:4", depth: "uchar" })).toBe(Math.floor(MB64 / 6));
    expect(maxPixels({ format: "jpeg", isProgressive: true, channels: 1, chromaSubsampling: "4:4:4", depth: "uchar" })).toBe(MB64 / 2);
    expect(maxPixels({ format: "png", isProgressive: true, channels: 4, depth: "uchar" })).toBe(MB64 / 4);
    expect(maxPixels({ format: "png", isProgressive: false, channels: 4, depth: "ushort" })).toBe(MB64 / 8);
    expect(maxPixels({ format: "webp", isProgressive: false, channels: 3, depth: "uchar" })).toBe(MB64 / 4);
  });

  it("takes no other format", () => {
    for (const format of ["heif", "gif", "tiff", "svg", "jp2", "raw"] as const) expect(maxPixels({ format, isProgressive: false, channels: 3, depth: "uchar" })).toBe(0);
  });
});

describe("saveUpload", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nukyok-storage-"));
    vi.stubEnv("UPLOAD_DIR", dir);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses from the header a tiny file that claims a huge image", async () => {
    await expect(saveUpload(file(pngHeader(16383, 16383, 16, 6, 1)), "attendance")).rejects.toThrow(TOO_BIG); // 65 bytes
    await expect(saveUpload(file(pngHeader(4800, 4800, 8, 2, 0)), "attendance")).rejects.toThrow(TOO_BIG); // 23 MP RGB
    await expect(saveUpload(file(jpegHeader(16000, 16000, 0xc2)), "attendance")).rejects.toThrow(TOO_BIG); // progressive
    await expect(saveUpload(file(jpegHeader(16000, 16000, 0xc0)), "attendance")).rejects.toThrow(TOO_BIG); // baseline 256 MP
  });

  it("refuses every format but JPEG, PNG and WebP before libvips reads it", async () => {
    const gif = await solid(8, 8).gif().toBuffer();
    const tiff = await solid(8, 8).tiff().toBuffer();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    for (const b of [gif, tiff, svg, "not an image"]) await expect(saveUpload(file(b), "attendance")).rejects.toThrow("ไฟล์ต้องเป็นรูป JPEG, PNG หรือ WebP");
    await expect(saveUpload(file(gif), "repair-bill", { pdf: true })).rejects.toThrow("ไฟล์ต้องเป็นรูป JPEG, PNG, WebP หรือ PDF");
    await expect(saveUpload(file("%PDF-1.4\n%%EOF"), "attendance")).rejects.toThrow("ต้องเป็นรูปภาพ");
  });

  it("stores a phone photo as a JPEG of at most 1600 px, turned upright", async () => {
    const photo = await solid(2000, 1000).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const key = await saveUpload(file(photo), "attendance");
    expect(key).toMatch(/^attendance\/\d{4}-\d{2}\/[0-9a-f-]{36}\.jpg$/);
    const saved = await readUpload(key);
    expect(saved?.type).toBe("image/jpeg");
    const meta = await sharp(saved!.body).metadata();
    expect([meta.format, meta.width, meta.height, meta.orientation]).toEqual(["jpeg", 800, 1600, undefined]);
    await removeUpload(key);
    expect(await readUpload(key)).toBeNull();
  });

  it("converts PNG and WebP, and keeps a PDF where one is allowed", async () => {
    const png = await solid(300, 200).png().toBuffer();
    const webp = await solid(300, 200).webp().toBuffer();
    const keys = await Promise.all([saveUpload(file(png), "repair"), saveUpload(file(webp), "repair"), saveUpload(file("%PDF-1.4\n%%EOF"), "repair-bill", { pdf: true })]);
    expect(keys.map((k) => k.slice(-4))).toEqual([".jpg", ".jpg", ".pdf"]);
    expect((await readUpload(keys[2]))?.type).toBe("application/pdf");
  });
});
