"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Icon, Notice, btnCls, btn2Cls, inputCls } from "./ui";

// <form> posting its FormData (files included) to a route handler that answers
// { ok, redirect?, notice? } or { error }. On success: show `notice` if any, then go to
// `redirect` (the answer's own wins) or refresh the page.
export function ApiForm({
  action,
  redirect,
  submit = "บันทึก",
  confirm: confirmText,
  children,
  className = "",
}: {
  action: string;
  redirect?: string;
  submit?: string;
  confirm?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(action, { method: "POST", body: new FormData(e.currentTarget) });
      const out = await res.json().catch(() => ({}));
      if (res.status === 413) throw new Error("ไฟล์รวมกันใหญ่เกินไป ลองส่งรูปให้น้อยลง");
      if (!res.ok || out.error) throw new Error(out.error || `ผิดพลาด (${res.status})`);
      if (out.notice) window.alert(out.notice);
      const to = out.redirect || redirect;
      if (to) router.push(to);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  }
  return (
    <form onSubmit={onSubmit} className={className}>
      {children}
      {error && (
        <Notice tone="danger" className="mb-3">
          {error}
        </Notice>
      )}
      <button type="submit" disabled={busy} className={`${btnCls} w-full`}>
        {busy ? "กำลังบันทึก..." : submit}
      </button>
    </form>
  );
}

// One button posting JSON. `note` asks for a text first (required when "required").
export function ActionButton({
  action,
  body = {},
  label,
  confirm: confirmText,
  note,
  primary,
  redirect,
}: {
  action: string;
  body?: Record<string, unknown>;
  label: string;
  confirm?: string;
  note?: { prompt: string; required?: boolean };
  primary?: boolean;
  redirect?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    let text = "";
    if (note) {
      const v = window.prompt(note.prompt);
      if (v === null) return;
      text = v.trim();
      if (note.required && !text) return window.alert("ต้องกรอกเหตุผล");
    } else if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await fetch(action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, note: text }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) throw new Error(out.error || `ผิดพลาด (${res.status})`);
      if (out.notice) window.alert(out.notice);
      if (out.redirect || redirect) router.push(out.redirect || redirect);
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" onClick={run} disabled={busy} className={primary ? btnCls : btn2Cls}>
      {busy ? "..." : label}
    </button>
  );
}

// /ai: makes a new เลขา AI key and shows it this once, with a copy button.
export function AiKeyButton({ replace }: { replace: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function run() {
    if (replace && !window.confirm("สร้างรหัสใหม่? รหัสเดิมจะใช้ไม่ได้ทันที ต้องใส่รหัสใหม่ในเลขา AI")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.key) throw new Error(out.error || `ผิดพลาด (${res.status})`);
      setKey(out.key);
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  if (key)
    return (
      <div className="w-full">
        <Notice tone="info" className="mb-2">
          คัดลอกรหัสนี้ไปใส่ในเลขา AI ตอนนี้ ระบบจะไม่แสดงรหัสนี้อีก
        </Notice>
        <div className="flex gap-2">
          <input readOnly value={key} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-xl border border-line bg-hover px-3 py-2 font-mono text-sm" />
          <button
            type="button"
            className={btn2Cls}
            onClick={async () => {
              await navigator.clipboard.writeText(key).then(() => setCopied(true), () => window.alert("คัดลอกไม่ได้ ให้กดค้างที่ช่องแล้วคัดลอกเอง"));
            }}
          >
            {copied ? "คัดลอกแล้ว" : "คัดลอก"}
          </button>
        </div>
      </div>
    );
  return (
    <button type="button" onClick={run} disabled={busy} className={btnCls}>
      {busy ? "..." : replace ? "สร้างรหัสใหม่" : "สร้างรหัสเลขา AI"}
    </button>
  );
}

// Driver forms: the vehicle list plus "ไม่มีในรายการ" to type the plate and model (the server adds that vehicle for
// Office to complete). With no vehicle listed yet, typing is the only way.
export function VehiclePicker({ vehicles, defaultValue }: { vehicles: { id: string; code: string; model: string }[]; defaultValue: string }) {
  const [picked, setPicked] = useState(vehicles.length ? defaultValue : "new");
  return (
    <>
      <Field label="รถ">
        <select name="vehicleId" required value={picked} onChange={(e) => setPicked(e.target.value)} className={inputCls}>
          <option value="">-- เลือกรถ --</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.model ? `${v.code} - ${v.model}` : v.code}
            </option>
          ))}
          <option value="new">+ ไม่มีในรายการ (พิมพ์ทะเบียนเอง)</option>
        </select>
      </Field>
      {picked === "new" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="ทะเบียน / รหัสรถ">
            <input name="newCode" required maxLength={30} className={inputCls} />
          </Field>
          <Field label="รุ่น">
            <input name="newModel" required maxLength={100} className={inputCls} />
          </Field>
        </div>
      )}
    </>
  );
}

// The filler form's slip photo: sent at once to `action` (/api/fuel/<id>/slip), which keeps it and has the AI read
// it. What was read fills litres, price, amount, invoice and pump name and picks "ปั๊ม"; the filler checks them.
export function SlipInput({ action }: { action: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [url, setUrl] = useState("");
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setMsg("กำลังส่งรูปและอ่านสลิป...");
    try {
      const fd = new FormData();
      fd.append("slip", file);
      const res = await fetch(action, { method: "POST", body: fd });
      const out = await res.json().catch(() => ({}));
      if (res.status === 413) throw new Error("รูปใหญ่เกินไป");
      if (!res.ok || out.error) throw new Error(out.error || `ผิดพลาด (${res.status})`);
      setUrl(URL.createObjectURL(file));
      const read = out.read as Record<string, string | number | null> | null;
      const form = input.form;
      if (read && form) {
        const set = (name: string, v: string | number | null) => {
          const el = form.elements.namedItem(name);
          if (el instanceof HTMLInputElement && v !== null && v !== "") el.value = String(v);
        };
        set("liters", read.liters);
        set("pricePerLiter", read.pricePerLiter);
        set("amount", read.amount);
        set("invoice", read.invoice);
        set("supplierName", read.station);
        const pump = form.querySelector<HTMLInputElement>('input[name="source"][value="pump"]');
        if (pump) pump.checked = true;
      }
      setMsg(read ? "อ่านสลิปแล้ว ตรวจตัวเลขให้ตรงกับสลิปก่อนบันทึก" : out.note || "บันทึกรูปสลิปแล้ว กรอกตัวเลขเอง");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      input.value = "";
    }
  }
  return (
    <div className="rounded-xl border-2 border-dashed border-line bg-bg/60 p-3">
      {/* no capture: phones offer the camera and the photo library (a slip is often photographed beforehand);
          with capture, LINE on iOS opens only the camera, or nothing without camera permission */}
      <input
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={onChange}
        className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2 file:font-semibold file:text-white"
      />
      {url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="mt-2 h-20 w-20 rounded-xl border border-line object-cover" />
      )}
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}

// Camera / gallery picker with previews. capture="environment" opens the back camera on phones.
export function PhotoInput({ name, required, multiple, camera = true, pdf }: { name: string; required?: boolean; multiple?: boolean; camera?: boolean; pdf?: boolean }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return (
    <div className="rounded-xl border-2 border-dashed border-line bg-bg/60 p-3">
      <input
        type="file"
        name={name}
        required={required}
        multiple={multiple}
        accept={pdf ? "image/*,application/pdf" : "image/*"}
        {...(camera && !pdf ? { capture: "environment" as const } : {})}
        onChange={(e) => setUrls([...(e.target.files ?? [])].filter((f) => f.type.startsWith("image/")).map((f) => URL.createObjectURL(f)))}
        className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2 file:font-semibold file:text-white"
      />
      {!!urls.length && (
        <div className="mt-2 flex flex-wrap gap-2">
          {urls.map((u) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={u} src={u} alt="" className="h-20 w-20 rounded-xl border border-line object-cover" />
          ))}
        </div>
      )}
    </div>
  );
}

// Fills hidden lat / lng inputs from the phone's GPS (กดอนุญาตตำแหน่ง).
export function GpsInput() {
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [msg, setMsg] = useState("กำลังหาตำแหน่ง...");
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
        setMsg(`ตำแหน่ง ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} (±${Math.round(p.coords.accuracy)} ม.)`);
      },
      () => setMsg("ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง (บันทึกได้ แต่ไม่มีพิกัด)"),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, []);
  return (
    <div className="mb-4 flex items-center gap-2 rounded-xl bg-hover px-3 py-2 text-sm text-muted">
      <input type="hidden" name="lat" value={pos?.lat ?? ""} />
      <input type="hidden" name="lng" value={pos?.lng ?? ""} />
      <Icon name="pin" className={`h-4 w-4 shrink-0 ${pos ? "text-[#16A34A]" : ""}`} />
      {msg}
    </div>
  );
}
