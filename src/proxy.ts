import { NextResponse, type NextRequest } from "next/server";

// Only passes the requested path on to server pages, so requirePage() can send
// people back where they were after logging in. Access checks live in the pages
// and route handlers (requirePage / apiUser), not here.
export function proxy(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set("x-path", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: h } });
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"],
};
