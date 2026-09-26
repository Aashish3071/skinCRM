import { getEnv } from "@skincrm/config";
import { MockEmailConnector } from "./email/mock";
import { MockWhatsAppConnector } from "./whatsapp/mock";
import type { Connectors } from "./types";

export * from "./types";
export { MockEmailConnector } from "./email/mock";
export { MockWhatsAppConnector } from "./whatsapp/mock";

let cached: Connectors | undefined;

/**
 * Resolve the connectors for this process from `CONNECTOR_*`.
 *
 * Live implementations do not exist yet; a connector set to `live` fails loudly
 * at resolution rather than silently falling back to a mock. Quietly mocking in
 * production would mean a clinic believing messages were sent when nothing left
 * the building.
 */
export function getConnectors(): Connectors {
  if (cached) return cached;
  const env = getEnv();

  cached = {
    email:
      env.CONNECTOR_EMAIL === "mock"
        ? new MockEmailConnector()
        : notImplemented("email", "phase 7"),
    whatsapp:
      env.CONNECTOR_WHATSAPP === "mock"
        ? new MockWhatsAppConnector()
        : notImplemented("whatsapp", "phase 7"),
  };
  return cached;
}

function notImplemented(name: string, phase: string): never {
  throw new Error(
    `CONNECTOR_${name.toUpperCase()}=live, but no live ${name} connector exists yet (${phase}). ` +
      `Set it back to "mock", or implement the adapter — do not let this fall through to a mock.`,
  );
}

/** Tests replace the whole set. */
export function setConnectors(connectors: Connectors): void {
  cached = connectors;
}

export function resetConnectors(): void {
  cached = undefined;
}
