import { registerDeliveryRecoveryRoutes } from "./messaging/recovery-routes";
import { registerCrmSettingsRoutes } from "./settings/routes";
import { randomUUID, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { getEnv } from "@skincrm/config";
import { registerAuthRoutes } from "./auth/routes";
import { registerAuditLogRoutes } from "./audit-log/routes";
import { registerErrorHandler } from "./errors";
import { logger } from "./logger";
import { registerRoute } from "./route";
import { registerAssignmentRuleRoutes } from "./leads/assignment-routes";
import { registerAutomationRoutes } from "./automations/routes";
import { registerCalendarRoutes } from "./calendar/routes";
import { registerInboxRoutes } from "./inbox/routes";
import { registerIntegrationRoutes } from "./integrations/routes";
import { registerOAuthRoutes } from "./integrations/oauth";
import { registerSavedViewRoutes } from "./leads/views-routes";
import { registerWebhooks } from "./integrations/webhooks";
import { registerIntakeRoutes } from "./intake/routes";
import { registerLeadRoutes } from "./leads/routes";
import { registerMessagingRoutes } from "./messaging/routes";
import { registerUnsubscribeRoutes } from "./messaging/unsubscribe-routes";
import { registerPeopleRoutes } from "./people/routes";
import { registerFeedbackRoutes } from "./feedback/routes";
import { registerNotificationRoutes } from "./notifications/routes";
import { registerProfileRoutes } from "./profile/routes";
import { registerReportRoutes } from "./reports/routes";
import { registerUserRoutes } from "./users/routes";
import { registerWorkspaceRoutes } from "./workspace/routes";

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    /**
     * Our own pino instance, so redaction applies to Fastify's request logs too.
     * Widened to FastifyBaseLogger: passing a concrete pino Logger would narrow
     * the FastifyInstance generic and stop it matching the plain FastifyInstance
     * our route helpers accept.
     */
    loggerInstance: logger as FastifyBaseLogger,
    // Correlation id. Honour an upstream one so a trace spans the web app and API.
    genReqId: (request) => {
      const header = request.headers["x-correlation-id"];
      return typeof header === "string" && header.length > 0 && header.length <= 64 ? header : randomUUID();
    },
    trustProxy: true,
    // Cap request bodies. CSV import uses its own streaming endpoint (phase 2)
    // rather than raising this for every route.
    bodyLimit: 1_048_576,
    // Signed tokens in the path (unsubscribe links) run to ~160 characters;
    // Fastify's default of 100 answers them with 414.
    maxParamLength: 600,
    /**
     * The route helper emits exactly one structured line per request, so
     * Fastify's own request/response pair would just be noise.
     *
     * This option is deprecated in Fastify 5 and removed in 6; the replacement
     * (`logController`) wants a LogController instance rather than a plain
     * object. Swap it when upgrading to Fastify 6.
     */
    disableRequestLogging: true,
  });

  await app.register(helmet, {
    // The API serves JSON only; a restrictive CSP costs nothing here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  await app.register(cors, {
    // Only the clinic-facing web app may call this with credentials. A wildcard
    // origin cannot be combined with cookies, and should not be.
    origin: [`http://localhost:${env.WEB_PORT}`, `http://127.0.0.1:${env.WEB_PORT}`],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "x-correlation-id"],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: "lax", path: "/" },
  });

  await app.register(rateLimit, {
    global: false, // opted into per route, so a burst of reads cannot throttle writes
    max: 300,
    timeWindow: "1 minute",
  });

  // Keep the raw JSON text: Meta's webhook signature is over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body as string;
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const error = new Error("The request body is not valid JSON.") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  registerErrorHandler(app);

  // --- Health checks ------------------------------------------------------
  registerRoute(app, {
    method: "GET",
    url: "/health",
    auth: false,
    handler: async () => ({ status: "ok", service: "api" }),
  });

  registerRoute(app, {
    method: "GET",
    url: "/health/ready",
    auth: false,
    // 503 whenever the app cannot do its job, so load balancers and container
    // probes (which only look at the status code) take it out of rotation.
    handler: async ({ reply }) => {
      // Readiness means the database answers, not merely that the process is up.
      try {
        const { getDb } = await import("@skincrm/db");
        await getDb().sql`select 1`;
      } catch {
        return reply.code(503).send({ status: "unavailable", database: "down", worker: "unknown", workerLastSeen: null });
      }
      const { lastBeat } = await import("./ops/monitor");
      const worker = await lastBeat("worker");
      const workerOk = worker !== null && Date.now() - worker.getTime() < 3 * 60_000;
      const body = { status: workerOk ? "ready" : "degraded", database: "ok", worker: workerOk ? "ok" : "stale", workerLastSeen: worker?.toISOString() ?? null };
      return workerOk ? body : reply.code(503).send(body);
    },
  });

  /**
   * For an external uptime monitor (UptimeRobot, Better Stack…): 200 with an
   * empty list when all is well, 503 with the alerts otherwise. Protected by a
   * shared token; the messages carry clinic names and counts, no personal data.
   */
  // A plain route (not registerRoute): it sets its own status code, 503
  // while any alert is open, which is what uptime monitors key on.
  app.get("/health/alerts", async (request, reply) => {
    const token = getEnv().MONITOR_TOKEN;
    const given = request.headers["x-monitor-token"];
    if (!token || typeof given !== "string" || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    }
    const { collectAlerts } = await import("./ops/monitor");
    const alerts = await collectAlerts();
    return reply.code(alerts.length ? 503 : 200).send({ ok: alerts.length === 0, alerts });
  });

  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerPeopleRoutes(app);
  registerLeadRoutes(app);
  registerAssignmentRuleRoutes(app);
  registerIntakeRoutes(app);
  registerCalendarRoutes(app);
  registerMessagingRoutes(app);
  registerDeliveryRecoveryRoutes(app);
  registerAutomationRoutes(app);
  registerUnsubscribeRoutes(app);
  registerWorkspaceRoutes(app);
  registerInboxRoutes(app);
  registerIntegrationRoutes(app);
  registerOAuthRoutes(app);
  registerSavedViewRoutes(app);
  registerWebhooks(app);
  registerReportRoutes(app);
  registerAuditLogRoutes(app);
  registerProfileRoutes(app);
  registerCrmSettingsRoutes(app);
  registerNotificationRoutes(app);
  registerFeedbackRoutes(app);

  return app;
}
