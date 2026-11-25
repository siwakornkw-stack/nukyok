import { NextResponse, type NextRequest } from "next/server";

// Only passes the requested path on to server pages, so requirePage() can send
// people back where they were after logging in. Access checks live in the pages
// and route handlers (requirePage / apiUser), not here. /api is left out on purpose:
// Next buffers the body of every request the proxy sees and cuts it at 10 MB (forms
// carry up to 100 MB of photos). The API's cross-site check is apiUser / crossSite.
// Pages may not be shown in another site's frame: a page on a sibling subdomain (same
// site, so our cookie goes along) could make an Office user click อนุมัติ unseen.
export function proxy(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set("x-path", req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers: h } });
  res.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  return res;
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"],
};
