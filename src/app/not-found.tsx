import Link from "next/link";
import { AuthShell, btnCls } from "@/components/ui";

export default function NotFound() {
  return (
    <AuthShell title="ไม่พบหน้านี้">
      <Link href="/" className={`${btnCls} block`}>
        กลับหน้าแรก
      </Link>
    </AuthShell>
  );
}
