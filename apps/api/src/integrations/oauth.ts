import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  completeOAuthSchema,
  oauthCallbackSchema,
  oauthProviderSchema,
  type OAuthChoice,
  type OAuthCompleteResult,
  type OAuthPendingDto,
  type OAuthProvider,
} from "@skincrm/contracts";
import { getEnv } from "@skincrm/config";
import { ConnectorError, getOAuthClients, type GoogleAdsAccount } from "@skincrm/connectors";
import { schema } from "@skincrm/db";
import { decryptForClinic, encryptForClinic, generateToken, hashToken } from "@skincrm/security";
import { getContext, getTx } from "../context";
import { badRequest, notFound } from "../errors";
import { recordAudit } from "../audit";
import { registerRoute } from "../route";
import { getConnection, secretOf } from "./connections";
import { serializeConnection, upsertConnection } from "./routes";
import { sha256 } from "./webhooks";

/**
 * "Connect with Facebook" and "Connect with Google Ads" (D-87).
 *
 *   start    → a one-time `state` (10 min, bound to this clinic and person) and
 *              the provider's sign-in URL.
 *   callback → the web app forwards `code` + `state` here; we check and burn the
 *              state, trade the code for a token, and list what the person can
 *              connect (Pages / ad accounts). The token and the list are kept
 *              encrypted for 15 minutes behind a one-time "pending" id.
 *   complete → they picked one: store the connection and switch on lead
 *              delivery (Page subscription / webhook on every lead form).
 *
 * Both one-time ids live in `auth_tokens` as SHA-256 hashes, like invites.
 */
const STATE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const { authTokens, integrationConnections } = schema;

type PendingSecret =
  | { provider: "meta"; pages: { id: string; name: string; token: string; canReadLeads: boolean }[] }
  | { provider: "google"; refreshToken: string; accounts: GoogleAdsAccount[] };

export function oauthRedirectUri(provider: OAuthProvider): string {
  return new URL(`/settings/integrations/oauth/${provider}/callback`, getEnv().PUBLIC_WEB_URL).toString();
}

function googleWebhookUrl(): string {
  return `${getEnv().PUBLIC_API_URL.replace(/\/$/, "")}/webhooks/google/lead-form`;
}

const formatCustomerId = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");

/** Provider failures become a message the person can act on, never a 500. */
async function provider<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConnectorError) throw badRequest(`${label}: ${error.message}`);
    throw error;
  }
}

async function takeToken(token: string, purpose: string) {
  const context = getContext();
  const rows = await getTx()
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(authTokens.tokenHash, hashToken(token)),
      eq(authTokens.purpose, purpose),
      eq(authTokens.userId, context.userId!),
      isNull(authTokens.consumedAt),
      gt(authTokens.expiresAt, new Date()),
    ))
    .returning();
  return rows[0] ?? null;
}

async function peekToken(token: string, purpose: string) {
  const context = getContext();
  const rows = await getTx().select().from(authTokens).where(and(
    eq(authTokens.tokenHash, hashToken(token)),
    eq(authTokens.purpose, purpose),
    eq(authTokens.userId, context.userId!),
    isNull(authTokens.consumedAt),
    gt(authTokens.expiresAt, new Date()),
  )).limit(1);
  return rows[0] ?? null;
}

function choicesFor(secret: PendingSecret): OAuthChoice[] {
  if (secret.provider === "meta") {
    return secret.pages.map((p) => ({
      id: p.id,
      label: p.name,
      detail: `Page ${p.id}`,
      unavailableReason: p.canReadLeads ? null : "You need to be an admin or advertiser on this Page to receive its leads.",
    }));
  }
  return secret.accounts.map((a) => ({
    id: a.customerId,
    label: a.name,
    detail: `${formatCustomerId(a.customerId)}${a.loginCustomerId ? ` · via manager ${formatCustomerId(a.loginCustomerId)}` : ""}`,
    unavailableReason: null,
  }));
}

/** Put our webhook on every lead form that doesn't already have it. */
async function attachLeadForms(refreshToken: string, account: GoogleAdsAccount, key: string, onlyMissing: boolean) {
  const client = getOAuthClients().google;
  const url = googleWebhookUrl();
  const forms = await provider("Google Ads", () => client.listLeadForms(refreshToken, account));
  let added = 0;
  const failed: string[] = [];
  const elsewhere: string[] = [];
  for (const form of forms) {
    if (onlyMissing && form.webhookUrls.includes(url)) continue;
    // Never take over a form another tool (a previous CRM, Zapier…) relies on.
    if (form.webhookUrls.some((u) => u !== url)) {
      elsewhere.push(form.name);
      continue;
    }
    try {
      await client.addWebhook(refreshToken, account, form, { url, key });
      added += 1;
    } catch (error) {
      failed.push(`${form.name} (${error instanceof Error ? error.message : "failed"})`);
    }
  }
  return { total: forms.length, added, failed, elsewhere };
}

function formsSentence(result: { total: number; added: number; failed: string[]; elsewhere: string[] }, onlyMissing: boolean): string {
  const parts: string[] = [];
  const ours = result.total - result.elsewhere.length;
  if (result.total === 0) parts.push("There are no lead forms in this account yet. Create one in Google Ads, then press Check for new lead forms.");
  else if (onlyMissing && result.added === 0 && result.failed.length === 0 && ours > 0) parts.push(`All ${ours} lead forms already send leads to SkinCRM.`);
  else parts.push(`${result.added} lead ${result.added === 1 ? "form now sends" : "forms now send"} leads to SkinCRM.`);
  if (result.elsewhere.length) parts.push(`Left alone because they already send leads to another system: ${result.elsewhere.join(", ")}. Remove that webhook in Google Ads first, then press Check for new lead forms.`);
  if (result.failed.length) parts.push(`Couldn't update: ${result.failed.join("; ")}. Add the webhook to those by hand (Advanced).`);
  return parts.join(" ");
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: "POST",
    url: "/integrations/oauth/:provider/start",
    auth: { capability: "integrations:write" },
    params: z.object({ provider: oauthProviderSchema }),
    handler: async ({ params }) => {
      const context = getContext();
      const client = await provider("Setup", async () => getOAuthClients()[params.provider]);
      const { token, tokenHash } = generateToken(32);
      await getTx().insert(authTokens).values({
        clinicId: context.clinicId!,
        userId: context.userId,
        purpose: "oauth_state",
        tokenHash,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
        metadata: { provider: params.provider },
      });
      return { url: client.authorizeUrl({ state: token, redirectUri: oauthRedirectUri(params.provider) }), mode: client.mode };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/integrations/oauth/:provider/callback",
    auth: { capability: "integrations:write" },
    params: z.object({ provider: oauthProviderSchema }),
    body: oauthCallbackSchema,
    handler: async ({ params, body }) => {
      const context = getContext();
      const state = await takeToken(body.state, "oauth_state");
      // Wrong person, other clinic, reused, expired or forged: all the same answer.
      if (!state || state.metadata.provider !== params.provider) {
        throw badRequest("This sign-in link has expired or was already used. Start again from Settings.");
      }
      const clients = getOAuthClients();
      const redirectUri = oauthRedirectUri(params.provider);
      let secret: PendingSecret;
      if (params.provider === "meta") {
        const userToken = await provider("Facebook", () => clients.meta.exchangeCode({ code: body.code, redirectUri }));
        const pages = await provider("Facebook", () => clients.meta.listPages(userToken));
        if (!pages.length) throw badRequest("Your Facebook account doesn't manage any Pages, or you didn't allow access to them. Try again and tick the clinic's Page.");
        secret = { provider: "meta", pages: pages.map((p) => ({ id: p.id, name: p.name, token: p.accessToken, canReadLeads: p.canReadLeads })) };
      } else {
        const refreshToken = await provider("Google", () => clients.google.exchangeCode({ code: body.code, redirectUri }));
        const accounts = await provider("Google Ads", () => clients.google.listAccounts(refreshToken));
        if (!accounts.length) throw badRequest("That Google account can't reach any Google Ads accounts. Sign in with the account that manages the clinic's ads.");
        secret = { provider: "google", refreshToken, accounts };
      }

      const { token, tokenHash } = generateToken(32);
      await getTx().insert(authTokens).values({
        clinicId: context.clinicId!,
        userId: context.userId,
        purpose: "oauth_pending",
        tokenHash,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        metadata: { provider: params.provider, sealed: encryptForClinic(context.clinicId!, JSON.stringify(secret)) },
      });
      return { pendingId: token };
    },
  });

  registerRoute(app, {
    method: "GET",
    url: "/integrations/oauth/pending/:id",
    auth: { capability: "integrations:write" },
    params: z.object({ id: z.string().min(20).max(200) }),
    handler: async ({ params }): Promise<OAuthPendingDto> => {
      const row = await peekToken(params.id, "oauth_pending");
      if (!row) throw notFound("This connection request has expired. Start again from Settings.");
      const secret = JSON.parse(decryptForClinic(row.clinicId, String(row.metadata.sealed))) as PendingSecret;
      return { id: params.id, provider: secret.provider, choices: choicesFor(secret), expiresAt: row.expiresAt.toISOString() };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/integrations/oauth/pending/:id/complete",
    auth: { capability: "integrations:write" },
    params: z.object({ id: z.string().min(20).max(200) }),
    body: completeOAuthSchema,
    handler: async ({ params, body }): Promise<OAuthCompleteResult> => {
      const row = await takeToken(params.id, "oauth_pending");
      if (!row) throw notFound("This connection request has expired. Start again from Settings.");
      const secret = JSON.parse(decryptForClinic(row.clinicId, String(row.metadata.sealed))) as PendingSecret;

      if (secret.provider === "meta") {
        const page = secret.pages.find((p) => p.id === body.choiceId);
        if (!page) throw badRequest("Pick one of the Pages listed.");
        if (!page.canReadLeads) throw badRequest("You need to be an admin or advertiser on this Page to receive its leads.");
        // Subscribe first: a saved connection that receives nothing is worse than a clear error.
        await provider("Facebook refused to send this Page's leads to SkinCRM", () => getOAuthClients().meta.subscribePage(page.id, page.token));
        const connection = await upsertConnection("meta_lead_ads", page.id, page.name, page.token, { via: "oauth" });
        return { connection, detail: `Connected ${page.name}. New leads from its forms will arrive in Leads within seconds.` };
      }

      const account = secret.accounts.find((a) => a.customerId === body.choiceId);
      if (!account) throw badRequest("Pick one of the ad accounts listed.");
      const key = randomBytes(24).toString("base64url");
      const result = await attachLeadForms(secret.refreshToken, account, key, false);
      // One Google connection per clinic: replace any earlier one (and its key).
      const existing = await getConnection("google_lead_forms");
      if (existing) await getTx().delete(integrationConnections).where(eq(integrationConnections.id, existing.id));
      const connection = await upsertConnection(
        "google_lead_forms",
        sha256(key),
        `Google Ads · ${account.name}`,
        JSON.stringify({ key, refreshToken: secret.refreshToken, account }),
        { via: "oauth", customerId: account.customerId, loginCustomerId: account.loginCustomerId, leadForms: String(result.added) },
      );
      return { connection, detail: formsSentence(result, false) };
    },
  });

  /** Forms created after connecting don't have our webhook yet. */
  registerRoute(app, {
    method: "POST",
    url: "/integrations/google/sync-forms",
    auth: { capability: "integrations:write" },
    handler: async () => {
      const connection = await getConnection("google_lead_forms");
      if (!connection || connection.config.via !== "oauth") throw badRequest("Connect with Google Ads first.");
      const stored = JSON.parse(secretOf(connection) ?? "{}") as { key?: string; refreshToken?: string; account?: GoogleAdsAccount };
      if (!stored.key || !stored.refreshToken || !stored.account) throw badRequest("Reconnect with Google Ads.");
      const result = await attachLeadForms(stored.refreshToken, stored.account, stored.key, true);
      const withWebhook = result.total - result.failed.length - result.elsewhere.length;
      const rows = await getTx()
        .update(integrationConnections)
        .set({ config: { ...connection.config, leadForms: String(withWebhook) }, lastCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(integrationConnections.id, connection.id))
        .returning();
      await recordAudit({ action: "settings_changed", entityType: "integration", entityId: connection.id, changeSummary: { googleLeadForms: withWebhook } });
      return { connection: serializeConnection(rows[0]!), detail: formsSentence(result, true) };
    },
  });
}
