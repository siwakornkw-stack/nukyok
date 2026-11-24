import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { loginTarget } from "@/lib/session";
import { devLoginOn } from "@/lib/dev";
import { AuthShell, Notice } from "@/components/ui";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic";

// Login goes through LINE: the LIFF link opens /liff (the LIFF endpoint), which signs the
// person in and continues to `target`. Dev mode (DEV_LOGIN=1) offers a user picker instead.
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const target = loginTarget(sp);
  const liffId = process.env.LIFF_ID ?? "";
  const dev = devLoginOn();
  if (!sp.disabled && !dev && liffId) redirect(`https://liff.line.me/${liffId}${target === "/" ? "" : target}`);
  const devUsers = dev
    ? await prisma.user.findMany({ where: { status: { not: "disabled" } }, select: { id: true, name: true, displayName: true, roles: true }, orderBy: { name: "asc" } })
    : [];
  return (
    <AuthShell title="ระบบจัดการรถ">
      {sp.disabled ? (
        <Notice tone="danger">บัญชีนี้ถูกปิดการใช้งาน ติดต่อ Office</Notice>
      ) : (
        <LoginClient target={target} liffId={dev ? "" : liffId} devUsers={devUsers} />
      )}
    </AuthShell>
  );
}
