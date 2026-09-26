import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { getEnv } from "@skincrm/config";
import { registerAuthRoutes } from "./auth/routes";
import { registerErrorHandler } from "./errors";
import { logger } from "./logger";
import { registerRoute } from "./route";
import { registerAssignmentRuleRoutes } from "./leads/assignment-routes";
import { registerAutomationRoutes } from "./automations/routes";
import { registerCalendarRoutes } from "./calendar/routes";
import { registerIntakeRoutes } from "./intake/routes";
import { registerLeadRoutes } from "./leads/routes";
import { registerMessagingRoutes } from "./messaging/routes";
import { registerPeopleRoutes } from "./people/routes";
import { registerUserRoutes } from "./users/routes";

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
    handler: async () => {
      // Readiness means the database answers, not merely that the process is up.
      const { getDb } = await import("@skincrm/db");
      await getDb().sql`select 1`;
      return { status: "ready" };
    },
  });

  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerPeopleRoutes(app);
  registerLeadRoutes(app);
  registerAssignmentRuleRoutes(app);
  registerIntakeRoutes(app);
  registerCalendarRoutes(app);
  registerMessagingRoutes(app);
  registerAutomationRoutes(app);

  return app;
}
