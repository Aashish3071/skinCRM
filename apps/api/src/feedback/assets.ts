import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConnectorError, getMetaAdvertisingClient, getOAuthClients } from "@skincrm/connectors";
import type { FeedbackAssets } from "@skincrm/contracts";
import type { schema } from "@skincrm/db";
import { encryptForClinic } from "@skincrm/security";
import { getContext } from "../context";
import { badRequest } from "../errors";
import { registerRoute } from "../route";
import { getConnection, metaAdvertisingToken, secretOf } from "../integrations/connections";
import { cancelQueued, destinationRow, destinationSecrets } from "./service";

type Update = (destination: "meta" | "google", values: Partial<typeof schema.feedbackDestinations.$inferInsert>, summary: Record<string, unknown>) => Promise<unknown>;
const testCode = z.string().trim().max(40).optional();

export function registerFeedbackAssetRoutes(app: FastifyInstance, update: Update): void {
  registerRoute(app, {
    method: "GET", url: "/feedback/assets", auth: { capability: "feedback:write" },
    handler: async (): Promise<FeedbackAssets> => {
      const metaToken = await metaAdvertisingToken();
      const whatsapp = await getConnection("whatsapp_cloud");
      const google = await getConnection("google_lead_forms");
      const result: FeedbackAssets = { metaDatasets: [], googleActions: [], metaConnected: Boolean(metaToken), whatsappConnected: Boolean(whatsapp?.config.businessAccountId && whatsapp.encryptedSecret), googleConnected: google?.config.via === "oauth", errors: [] };
      if (metaToken) {
        try { result.metaDatasets = await getMetaAdvertisingClient().listDatasets(metaToken); }
        catch (error) { result.errors.push({ channel: "meta", message: error instanceof Error ? error.message : "Reconnect with Facebook" }); }
      }
      if (result.googleConnected && google) {
        const stored = JSON.parse(secretOf(google) ?? "{}");
        try { result.googleActions = await getOAuthClients().google.listConversionActions(stored.refreshToken, stored.account); }
        catch (error) { result.errors.push({ channel: "google", message: error instanceof Error ? error.message : "Reconnect with Google" }); }
      }
      return result;
    },
  });

  registerRoute(app, {
    method: "POST", url: "/feedback/meta/credentials/from-connection", auth: { capability: "feedback:write" },
    body: z.object({ datasetId: z.string().regex(/^\d{5,30}$/), testEventCode: testCode }),
    handler: async ({ body }) => {
      const token = await metaAdvertisingToken();
      const connection = await getConnection("meta_lead_ads");
      if (!token || !connection) throw badRequest("Connect with Facebook first, then allow access to the business and ad assets.");
      let datasets;
      try { datasets = await getMetaAdvertisingClient().listDatasets(token); }
      catch (error) { if (error instanceof ConnectorError) throw badRequest(error.message); throw error; }
      const dataset = datasets.find((d) => d.id === body.datasetId);
      if (!dataset) throw badRequest("Choose a dataset available to your connected Facebook account.");
      const row = await destinationRow("meta");
      await cancelQueued("meta", "Conversion destination changed");
      return update("meta", {
        config: { ...row.config, datasetId: dataset.id, datasetName: dataset.name, metaConnectionId: connection.id, whatsappTestOk: null },
        encryptedSecret: encryptForClinic(getContext().clinicId!, JSON.stringify({ ...destinationSecrets(row), accessToken: token, testEventCode: body.testEventCode ?? null })),
        eligibility: "unreviewed", lastTestOk: null, mappingVersion: row.mappingVersion + 1,
      }, { credentials: "set", via: "facebook_connection" });
    },
  });

  registerRoute(app, {
    method: "POST", url: "/feedback/meta/credentials/from-whatsapp", auth: { capability: "feedback:write" },
    body: z.object({ testEventCode: testCode }),
    handler: async ({ body }) => {
      const connection = await getConnection("whatsapp_cloud");
      const wabaId = connection?.config.businessAccountId;
      const token = connection ? secretOf(connection) : null;
      if (!connection || !wabaId || !token) throw badRequest("Connect WhatsApp with its business account first.");
      let datasetId: string;
      try { datasetId = await getMetaAdvertisingClient("whatsapp").ensureWhatsAppDataset(wabaId, token); }
      catch (error) { if (error instanceof ConnectorError) throw badRequest(`WhatsApp conversion setup: ${error.message}`); throw error; }
      const row = await destinationRow("meta");
      await cancelQueued("meta", "WhatsApp conversion destination changed");
      return update("meta", {
        config: { ...row.config, whatsappDatasetId: datasetId, whatsappBusinessAccountId: wabaId, whatsappConnectionId: connection.id, whatsappTestOk: null },
        encryptedSecret: encryptForClinic(getContext().clinicId!, JSON.stringify({ ...destinationSecrets(row), whatsappAccessToken: token, whatsappTestEventCode: body.testEventCode ?? null })),
        eligibility: "unreviewed", lastTestOk: null, mappingVersion: row.mappingVersion + 1,
      }, { credentials: "set", via: "whatsapp_connection" });
    },
  });

  registerRoute(app, {
    method: "GET", url: "/feedback/google/conversion-actions", auth: { capability: "feedback:write" },
    handler: async () => {
      const connection = await getConnection("google_lead_forms");
      if (!connection || connection.config.via !== "oauth") throw badRequest("Connect with Google Ads first.");
      const stored = JSON.parse(secretOf(connection) ?? "{}");
      try { return { items: await getOAuthClients().google.listConversionActions(stored.refreshToken, stored.account) }; }
      catch (error) { if (error instanceof ConnectorError) throw badRequest(error.message); throw error; }
    },
  });
}
