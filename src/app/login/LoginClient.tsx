"use client";
import { useEffect, useRef, useState } from "react";
import { btn2Cls, btnCls } from "@/components/ui";

type DevUser = { id: string; name: string; displayName: string; roles: string[] };

// LIFF login: inside LINE the user is already logged in; in an outside browser
// liff.login() goes through LINE Login and comes back here. The ID token is
// checked by the server (/api/auth/line), which sets the session cookie.
export default function LoginClient({ target, liffId, devUsers }: { target: string; liffId: string; devUsers: DevUser[] }) {
  const [msg, setMsg] = useState(liffId ? "กำลังเข้าสู่ระบบด้วย LINE..." : "");
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!liffId || started.current || devUsers.length) return;
    started.current = true;
    (async () => {
      try {
        const liff = (await import("@line/liff")).default;
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) return liff.login({ redirectUri: window.location.href });
        const res = await fetch("/api/auth/line", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: liff.getIDToken() }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `เข้าสู่ระบบไม่สำเร็จ (${res.status})`);
        window.location.replace(out.active ? target : "/register");
      } catch (e) {
        setFailed(true);
        setMsg(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [liffId, target, devUsers.length]);

  async function retry() {
    const liff = (await import("@line/liff")).default;
    if (liff.isLoggedIn()) liff.logout();
    window.location.reload();
  }

  async function devLogin(id: string) {
    const res = await fetch("/api/auth/dev", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: id }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(out.error || "ผิดพลาด");
    window.location.replace(out.active ? target : "/register");
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-5 shadow-[0_1px_3px_rgb(15_23_42/0.05)]">
      {msg && (
        <p className="mb-4 flex items-center justify-center gap-2 text-center">
          {!failed && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" />}
          {msg}
        </p>
      )}
      {failed && (
        <button onClick={retry} className={`${btnCls} w-full`}>
          ลองใหม่
        </button>
      )}
      {!liffId && !devUsers.length && <p className="text-center text-muted">ยังไม่ได้ตั้งค่า LIFF_ID</p>}
      {!!devUsers.length && (
        <div>
          <p className="mb-3 text-sm text-muted">โหมดทดสอบ (DEV_LOGIN=1): เลือกผู้ใช้</p>
          <div className="grid gap-2">
            {devUsers.map((u) => (
              <button key={u.id} onClick={() => devLogin(u.id)} className={`${btn2Cls} text-left`}>
                {u.name || u.displayName} <span className="text-sm text-muted">({u.roles.join(", ") || "ยังไม่มีบทบาท"})</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
