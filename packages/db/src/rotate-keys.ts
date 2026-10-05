import { sql } from "drizzle-orm";
import { CIPHERTEXT_PATTERN, decryptForClinic, encryptForClinic, isEncryptedUnderOldKey } from "@skincrm/security";
import type { Database } from "./client";

/**
 * Re-encrypt every stored secret under the current root key (D-93), so an old
 * key can be retired. Safe to run repeatedly and while the app is running:
 * each value is decrypted with whichever configured key made it and written
 * back only if it changed key; a row updated meanwhile is simply re-read.
 *
 * Where secrets live: whole text columns, and ciphertext strings inside a few
 * JSON columns (sealed OAuth state, a WhatsApp registration PIN).
 */
const TEXT_COLUMNS: [table: string, column: string][] = [
  ["integration_connections", "encrypted_secret"],
  ["feedback_destinations", "encrypted_secret"],
  ["raw_payloads", "encrypted_payload"],
  ["inbound_events", "encrypted_payload"],
  ["delivery_attempts", "payload_encrypted"],
  ["users", "mfa_secret_encrypted"],
];
const JSON_COLUMNS: [table: string, column: string][] = [
  ["integration_connections", "config"],
  ["feedback_destinations", "config"],
  ["auth_tokens", "metadata"],
];

export interface RotationReport {
  reencrypted: number;
  alreadyCurrent: number;
  unreadable: { table: string; id: string }[];
}

function rotateJson(clinicId: string, value: unknown, report: RotationReport): { value: unknown; changed: boolean } {
  if (typeof value === "string" && CIPHERTEXT_PATTERN.test(value)) {
    if (!isEncryptedUnderOldKey(clinicId, value)) return { value, changed: false };
    return { value: encryptForClinic(clinicId, decryptForClinic(clinicId, value)), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => { const r = rotateJson(clinicId, v, report); changed ||= r.changed; return r.value; });
    return { value: next, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) { const r = rotateJson(clinicId, v, report); changed ||= r.changed; next[k] = r.value; }
    return { value: next, changed };
  }
  return { value, changed: false };
}

export async function rotateEncryptionKeys(db: Database, batchSize = 200): Promise<RotationReport> {
  const report: RotationReport = { reencrypted: 0, alreadyCurrent: 0, unreadable: [] };

  for (const [table, column] of TEXT_COLUMNS) {
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = (await db.execute(sql.raw(
        `select id, clinic_id, ${column} as value from ${table} where ${column} is not null and id > '${after}' order by id limit ${batchSize}`,
      ))) as unknown as { id: string; clinic_id: string; value: string }[];
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        try {
          if (!isEncryptedUnderOldKey(row.clinic_id, row.value)) { report.alreadyCurrent += 1; continue; }
          const next = encryptForClinic(row.clinic_id, decryptForClinic(row.clinic_id, row.value));
          await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${next} where id = ${row.id} and ${sql.identifier(column)} = ${row.value}`);
          report.reencrypted += 1;
        } catch {
          report.unreadable.push({ table, id: row.id });
        }
      }
    }
  }

  for (const [table, column] of JSON_COLUMNS) {
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = (await db.execute(sql.raw(
        `select id, clinic_id, ${column} as value from ${table} where ${column}::text like '%"v1:%' and id > '${after}' order by id limit ${batchSize}`,
      ))) as unknown as { id: string; clinic_id: string; value: unknown }[];
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        try {
          const { value, changed } = rotateJson(row.clinic_id, row.value, report);
          if (!changed) { report.alreadyCurrent += 1; continue; }
          await db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${JSON.stringify(value)}::jsonb where id = ${row.id}`);
          report.reencrypted += 1;
        } catch {
          report.unreadable.push({ table, id: row.id });
        }
      }
    }
  }
  return report;
}
