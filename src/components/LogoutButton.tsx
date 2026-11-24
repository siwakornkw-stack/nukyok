"use client";
import { Icon } from "./ui";

// "ออก": first forget the LIFF login this browser keeps (outside LINE the LIFF SDK would sign the
// person straight back in from it), then the form posts as usual so its 303 to /login is followed.
export default function LogoutButton() {
  function forgetLiff() {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("LIFF_STORE:")) localStorage.removeItem(k);
    } catch {}
  }
  return (
    <form action="/api/auth/logout" method="post" onSubmit={forgetLiff}>
      <button
        title="ออกจากระบบ"
        className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted transition hover:bg-hover hover:text-ink"
      >
        <Icon name="logout" className="h-4 w-4" />
        ออก
      </button>
    </form>
  );
}
