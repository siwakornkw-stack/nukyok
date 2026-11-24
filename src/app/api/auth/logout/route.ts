import { clearSession } from "@/lib/session";

// Relative Location: behind nginx req.url is the internal 127.0.0.1:3004 address.
export async function POST() {
  await clearSession();
  return new Response(null, { status: 303, headers: { Location: "/login" } });
}
