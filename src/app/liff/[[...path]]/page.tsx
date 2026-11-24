import { redirect } from "next/navigation";
import { currentUser, loginTarget, safePath } from "@/lib/session";
import { AuthShell } from "@/components/ui";
import LoginClient from "../../login/LoginClient";

export const dynamic = "force-dynamic";

// LIFF endpoint (LINE Developers: endpoint URL https://<host>/liff). LINE opens
// liff.line.me/<id>/<path> here as /liff?liff.state=/<path> (or /liff/<path>), and a login
// outside LINE comes back here with ?code&state, which the LIFF SDK must finish on this
// page: so no auth redirect before it runs. Then on to /<path>.
export default async function LiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ path = [] }, sp] = await Promise.all([params, searchParams]);
  const target = sp["liff.state"] ? loginTarget({ "liff.state": sp["liff.state"] }) : safePath(`/${path.map(encodeURIComponent).join("/")}`);
  const u = await currentUser();
  if (u?.status === "active" && u.roles.length && !sp.code) redirect(target);
  return (
    <AuthShell title="ระบบจัดการรถ">
      <LoginClient target={target} liffId={process.env.LIFF_ID ?? ""} devUsers={[]} />
    </AuthShell>
  );
}
