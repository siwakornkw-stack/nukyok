import Link from "next/link";
import { requirePage } from "@/lib/session";
import { ROLES, type Role } from "@/lib/roles";
import { Logo } from "@/components/ui";
import LogoutButton from "@/components/LogoutButton";

// Shell for every signed-in page (pages still check their own roles).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const u = await requirePage();
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 font-bold tracking-tight">
            <Logo />
            <span className="hidden sm:inline">ระบบจัดการรถ</span>
          </Link>
          <div className="min-w-0 flex-1 text-right leading-tight">
            <div className="truncate text-sm font-semibold">{u.name}</div>
            <div className="truncate text-xs text-muted">{u.roles.map((r) => ROLES[r as Role] ?? r).join(", ")}</div>
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-10 pt-5">{children}</main>
    </>
  );
}
