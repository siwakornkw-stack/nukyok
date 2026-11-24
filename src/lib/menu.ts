import type { Role } from "./roles";
import type { IconName } from "@/components/ui";

// The web equivalent of the role-based Rich Menu (and the home page tiles).
// Every page here checks the same roles with requirePage().
export const MENU: { href: string; label: string; icon: IconName; roles: Role[] }[] = [
  { href: "/driver/attendance", label: "เข้างาน / ออกงาน", icon: "clock", roles: ["driver"] },
  { href: "/driver/fuel", label: "ขอเติมน้ำมัน", icon: "fuel", roles: ["driver"] },
  { href: "/driver/repair", label: "แจ้งซ่อม", icon: "wrench", roles: ["driver"] },
  { href: "/driver/my", label: "รายการของฉัน / ตรวจรับรถ", icon: "list", roles: ["driver"] },
  { href: "/filler", label: "รายการรอเติมน้ำมัน", icon: "droplet", roles: ["filler"] },
  { href: "/office/fuel", label: "ตรวจรายการน้ำมัน", icon: "fuel", roles: ["office", "exec", "accounting"] },
  { href: "/exec/repairs", label: "อนุมัติงานซ่อม", icon: "check", roles: ["exec"] },
  { href: "/purchasing/repairs", label: "งานซ่อม (ใบเสนอราคา / ค่าซ่อม)", icon: "wrench", roles: ["purchasing", "office", "accounting"] },
  { href: "/purchasing/prices", label: "เทียบราคา (ข้อมูลซื้อจาก Express)", icon: "chart", roles: ["purchasing", "office", "accounting"] },
  { href: "/office/attendance", label: "รีพอร์ตเข้างาน / ออกงาน", icon: "calendar", roles: ["office", "exec"] },
  { href: "/office/vehicles", label: "ข้อมูลรถ / หน้าสินทรัพย์", icon: "truck", roles: ["office", "exec", "purchasing", "accounting"] },
  { href: "/office/costs", label: "Dashboard ต้นทุนต่อคัน", icon: "chart", roles: ["office", "exec", "accounting"] },
  { href: "/office/express", label: "Express (PK / H3 / R3, PO / RR)", icon: "file", roles: ["office", "accounting"] },
  { href: "/office/users", label: "ผู้ใช้ / อนุมัติบทบาท", icon: "users", roles: ["office"] },
];
