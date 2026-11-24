import { apiUser } from "@/lib/session";
import { readUpload } from "@/lib/storage";

// Stored photos / PDFs, for signed-in users only.
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const a = await apiUser();
  if ("res" in a) return a.res;
  const f = await readUpload((await params).key.join("/"));
  if (!f) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(f.body), {
    headers: { "Content-Type": f.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}
