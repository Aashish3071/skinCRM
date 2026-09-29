import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { isValidEmail, normalizePhone } from "@skincrm/contracts";

/**
 * CSV import (PRD ID-04).
 *
 * Uses `csv-parse` rather than a hand-rolled split: real client exports come out
 * of Excel with a BOM, CRLF line endings, quoted fields containing commas, and
 * newlines inside quotes. Getting any of those wrong corrupts the clinic's
 * existing customer list on the one import that matters most.
 */

export const IMPORTABLE_FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "email",
  "serviceInterest",
  "note",
  "submittedAt",
] as const;
export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

/** Column headers we can map without being told, lower-cased and stripped. */
const HEADER_HINTS: Record<ImportableField, string[]> = {
  firstName: ["firstname", "first", "givenname", "forename"],
  lastName: ["lastname", "last", "surname", "familyname"],
  fullName: ["fullname", "name", "customername", "clientname", "patientname", "contactname"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "cell", "cellphone", "tel", "telephone", "contactnumber"],
  email: ["email", "emailaddress", "mail", "e-mail"],
  serviceInterest: ["service", "serviceinterest", "interest", "treatment", "enquiryabout", "inquiryabout"],
  note: ["note", "notes", "comment", "comments", "message", "enquiry", "inquiry"],
  submittedAt: ["date", "submitted", "submittedat", "createdat", "enquirydate", "inquirydate"],
};

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  /** Stable across re-uploads of the same file; part of each row's external id. */
  fingerprint: string;
}

export function parseCsv(content: string): ParsedCsv {
  // Excel writes a UTF-8 BOM, which would otherwise become part of the first
  // header name and break every mapping.
  const withoutBom = content.replace(/^\uFEFF/, "");

  const records = parse(withoutBom, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as Record<string, string>[];

  const headers = records.length > 0 ? Object.keys(records[0]!) : [];

  return {
    headers,
    rows: records,
    fingerprint: createHash("sha256").update(withoutBom, "utf8").digest("hex").slice(0, 32),
  };
}

/** Best-guess mapping from column header to field, for the preview screen. */
export function suggestMapping(headers: string[]): Partial<Record<ImportableField, string>> {
  const mapping: Partial<Record<ImportableField, string>> = {};
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");

  for (const header of headers) {
    const key = normalize(header);
    for (const field of IMPORTABLE_FIELDS) {
      if (mapping[field]) continue;
      if (HEADER_HINTS[field].includes(key)) {
        mapping[field] = header;
        break;
      }
    }
  }
  return mapping;
}

export interface RowValidation {
  rowNumber: number;
  valid: boolean;
  /** Why this row cannot be imported. Shown per row in the preview. */
  errors: string[];
  /** Non-fatal observations, e.g. an unparseable phone that will still be kept. */
  warnings: string[];
  values: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    serviceInterest: string | null;
    note: string | null;
    submittedAt: string | null;
  };
}

/**
 * Validate one row against a mapping. Invalid rows are reported and skipped
 * rather than aborting the batch — a clinic importing 800 contacts should not
 * lose the whole import to three bad rows (PRD ID-04).
 */
export function validateRow(
  row: Record<string, string>,
  mapping: Partial<Record<ImportableField, string>>,
  rowNumber: number,
  clinicCountry: string,
): RowValidation {
  const pick = (field: ImportableField): string | null => {
    const column = mapping[field];
    if (!column) return null;
    const value = row[column]?.trim();
    return value ? value : null;
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  let firstName = pick("firstName");
  let lastName = pick("lastName");
  const fullName = pick("fullName");
  if (!firstName && !lastName && fullName) {
    // Split on the last space: "Maria de Souza" becomes "Maria de" / "Souza",
    // which is a better default than dropping the middle part.
    const parts = fullName.split(/\s+/);
    lastName = parts.length > 1 ? parts.pop()! : null;
    firstName = parts.join(" ") || null;
  }

  const phone = pick("phone");
  const email = pick("email");

  if (!phone && !email) {
    errors.push("No phone number or email address");
  } else if (phone && !email && !/\d{3,}/.test(phone)) {
    errors.push(`"${phone}" isn't a phone number and there is no email address`);
  }

  if (phone) {
    const parsed = normalizePhone(phone, clinicCountry);
    if (!parsed.valid) {
      // Kept, not rejected: staff can often still use it, and discarding a
      // client's only contact detail is worse than flagging it.
      warnings.push(`Phone "${phone}" could not be read as a number; it will be kept as written`);
    }
  }

  if (email && !isValidEmail(email)) {
    errors.push(`"${email}" does not look like an email address`);
  }

  let submittedAt: string | null = null;
  const rawDate = pick("submittedAt");
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) {
      warnings.push(`Could not read the date "${rawDate}"; the import time will be used instead`);
    } else {
      submittedAt = parsed.toISOString();
    }
  }

  return {
    rowNumber,
    valid: errors.length === 0,
    errors,
    warnings,
    values: {
      firstName,
      lastName,
      phone,
      email,
      serviceInterest: pick("serviceInterest"),
      note: pick("note"),
      submittedAt,
    },
  };
}

/**
 * Deterministic external id for a CSV row.
 *
 * Built from the file's content fingerprint plus the row index, so re-uploading
 * the same file produces the same ids and the unique index on
 * `(clinic, platform, external_id)` rejects every row as a duplicate. That is
 * what makes "reimporting the same import does not duplicate" true without any
 * application-level bookkeeping (PRD ID-04).
 */
export function csvRowExternalId(fingerprint: string, rowNumber: number): string {
  return `csv:${fingerprint}:${rowNumber}`;
}
