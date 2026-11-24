// Client-safe: role names and labels only.
export const ROLES = {
  driver: "คนขับ",
  filler: "คนเติม",
  office: "Office",
  exec: "ผู้บริหาร",
  purchasing: "จัดซื้อ",
  accounting: "บัญชี",
} as const;

export type Role = keyof typeof ROLES;

export const ROLE_KEYS = Object.keys(ROLES) as Role[];

export const isRole = (v: unknown): v is Role => typeof v === "string" && Object.hasOwn(ROLES, v);

export const hasRole = (u: { roles: string[] } | null | undefined, ...roles: Role[]) => !!u && roles.some((r) => u.roles.includes(r));
