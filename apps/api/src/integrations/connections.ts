import { and, eq } from "drizzle-orm";
import type { IntegrationProvider } from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getConnectors, WhatsAppCloudConnector, type WhatsAppConnector } from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { decryptForClinic } from "@skincrm/security";
import { getContext, getTx } from "../context";

const { integrationConnections } = schema;

export async function getConnection(provider: IntegrationProvider) {
  const rows = await getTx()
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.provider, provider))
    .limit(1);
  return rows[0] ?? null;
}

export function secretOf(connection: { clinicId: string; encryptedSecret: string | null }): string | null {
  return connection.encryptedSecret ? decryptForClinic(connection.clinicId, connection.encryptedSecret) : null;
}

/**
 * The WhatsApp sender for the current clinic.
 *
 * Mock mode: the shared in-process mock. Live mode: the clinic's own number and
 * token. Live with no connection throws a clear, non-retryable error rather
 * than pretending to send (D-56).
 */
export async function whatsappConnector(): Promise<WhatsAppConnector> {
  if (getEnv().CONNECTOR_WHATSAPP !== "live") return getConnectors().whatsapp;
  const connection = await getConnection("whatsapp_cloud");
  const token = connection ? secretOf(connection) : null;
  if (!connection || !token) {
    throw new ConnectorError("WhatsApp isn't connected for this clinic yet. Connect it in Settings → Integrations.", {
      retryable: false,
      providerCode: "not_connected",
    });
  }
  return new WhatsAppCloudConnector({ phoneNumberId: connection.externalAccountId, accessToken: token });
}

/** Record that a connection just did something (or failed to). */
export async function markConnection(id: string, outcome: { ok: boolean; error?: string | null }): Promise<void> {
  await getTx()
    .update(integrationConnections)
    .set({
      status: outcome.ok ? "healthy" : "error",
      lastError: outcome.ok ? null : (outcome.error ?? "Unknown error").slice(0, 500),
      ...(outcome.ok ? { lastEventAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(integrationConnections.id, id), eq(integrationConnections.clinicId, getContext().clinicId!)));
}
