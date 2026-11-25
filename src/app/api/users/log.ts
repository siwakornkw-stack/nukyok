import type { Prisma } from "@prisma/client";

// Who approved, re-enabled, disabled or changed the roles of whom: the latest 200, newest first, in AppSetting
// "user_audit", written in the same transaction as the change (the Office group's LINE message is lost when LINE
// refuses it). Shown on /office/users.
export const USER_AUDIT_KEY = "user_audit";
export type UserAuditEntry = { at: string; by: string; text: string };

export const readUserAudit = (v: unknown): UserAuditEntry[] =>
  (Array.isArray(v) ? v : []).filter(
    (e): e is UserAuditEntry =>
      !!e && typeof e === "object" && ["at", "by", "text"].every((k) => typeof (e as Record<string, unknown>)[k] === "string") && !Number.isNaN(Date.parse(e.at))
  );

export async function addUserAudit(tx: Prisma.TransactionClient, entry: UserAuditEntry) {
  const row = await tx.appSetting.findUnique({ where: { key: USER_AUDIT_KEY } });
  const value = [entry, ...readUserAudit(row?.value)].slice(0, 200);
  await tx.appSetting.upsert({ where: { key: USER_AUDIT_KEY }, create: { key: USER_AUDIT_KEY, value }, update: { value } });
}
