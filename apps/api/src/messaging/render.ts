/**
 * Template rendering (PRD MSG-02).
 *
 * A deliberately tiny language: `{{variable}}` and nothing else. No
 * conditionals, no loops, no expression evaluation. Clinic staff edit these,
 * they can carry personal data, and anything more expressive becomes an
 * injection surface for very little gain.
 */

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface RenderResult {
  text: string;
  /** Variables the template used that were not supplied. */
  missing: string[];
}

export function renderTemplate(body: string, variables: Record<string, string | null>): RenderResult {
  const missing: string[] = [];

  const text = body.replace(TOKEN, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      // Leave the token in place. A half-rendered message is obvious; a silent
      // blank reads as finished text and goes out looking broken.
      return `{{${name}}}`;
    }
    return value;
  });

  return { text, missing: [...new Set(missing)] };
}

/** Every variable a template references. */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(TOKEN)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Validate a template body against its allowed variables (PRD MSG-02:
 * "Missing variables fail validation"). Caught when the template is saved
 * rather than when a client receives a message with a gap in it.
 */
export function validateTemplateBody(
  body: string,
  allowedVariables: readonly string[],
): { valid: boolean; unknownVariables: string[] } {
  const used = extractVariables(body);
  const allowed = new Set(allowedVariables);
  const unknownVariables = used.filter((name) => !allowed.has(name));
  return { valid: unknownVariables.length === 0, unknownVariables };
}

/**
 * Variables the product offers, and what each means.
 *
 * Deliberately excludes anything clinical, and anything from General Notes:
 * PRD ID-08 says notes are never inserted into an automated message. There is
 * no `service` or `condition` here either — PRD 8 keeps those out of message
 * bodies and subject lines by default.
 */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  "person.firstName": "The client's first name",
  "person.fullName": "The client's full name",
  "clinic.name": "Your clinic's name",
  "clinic.phone": "Your clinic's contact number",
  "clinic.address": "Your clinic's postal address",
  "appointment.date": "Appointment date, in the clinic's timezone",
  "appointment.time": "Appointment start time, in the clinic's timezone",
  "appointment.staffName": "Who they are seeing",
  "link.unsubscribe": "Unsubscribe link — required on promotional email",
  "link.reschedule": "Self-service reschedule link",
};

export const ALL_TEMPLATE_VARIABLE_NAMES = Object.keys(TEMPLATE_VARIABLES);
