import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import type { ZodTypeAny, z } from "zod";
import type { Capability } from "@skincrm/contracts";
import { withTenant } from "@skincrm/db";
import { createContext, getContext, runWithContext, type RequestContext } from "./context";
import { badRequest, forbidden, unauthorized, zodDetails } from "./errors";
import { logger } from "./logger";
import { SESSION_COOKIE, resolveSession } from "./auth/sessions";

/**
 * One place where every cross-cutting concern attaches: correlation id, request
 * context, session resolution, capability check, the tenant transaction, and
 * input validation.
 *
 * Routes are declared through this helper rather than registered directly on
 * Fastify, so none of the above can be forgotten on a new endpoint. In
 * particular there is no way to write a handler that touches tenant data outside
 * a tenant-scoped transaction: `getTx()` only resolves inside one.
 */

export interface RouteAuth {
  /** Capability the caller must hold. Omit when any signed-in user may call it. */
  capability?: Capability;
}

export interface RouteDefinition<
  TBody extends ZodTypeAny | undefined = undefined,
  TQuery extends ZodTypeAny | undefined = undefined,
  TParams extends ZodTypeAny | undefined = undefined,
> {
  method: HTTPMethods;
  url: string;
  /** `false` for public routes (login, webhooks, health). */
  auth: RouteAuth | false;
  body?: TBody;
  query?: TQuery;
  params?: TParams;
  /** Status on success. Defaults to 200, or 201 for POST that returns a resource. */
  status?: number;
  /** Fastify rate-limit options for this route only. */
  rateLimit?: { max: number; timeWindow: string | number; keyGenerator?: (req: FastifyRequest) => string };
  handler: (input: {
    body: TBody extends ZodTypeAny ? z.infer<TBody> : undefined;
    query: TQuery extends ZodTypeAny ? z.infer<TQuery> : undefined;
    params: TParams extends ZodTypeAny ? z.infer<TParams> : undefined;
    ctx: RequestContext;
    request: FastifyRequest;
    reply: FastifyReply;
  }) => Promise<unknown>;
}

export function registerRoute<
  TBody extends ZodTypeAny | undefined = undefined,
  TQuery extends ZodTypeAny | undefined = undefined,
  TParams extends ZodTypeAny | undefined = undefined,
>(app: FastifyInstance, definition: RouteDefinition<TBody, TQuery, TParams>): void {
  app.route({
    method: definition.method,
    url: definition.url,
    ...(definition.rateLimit ? { config: { rateLimit: definition.rateLimit } } : {}),
    handler: async (request, reply) => {
      const context = createContext({
        correlationId: typeof request.id === "string" ? request.id : randomUUID(),
        ipAddress: clientIp(request),
        userAgent: request.headers["user-agent"] ?? null,
      });

      return runWithContext(context, async () => {
        const started = Date.now();

        // --- Input validation, before any authentication work ---------------
        const body = parse(definition.body, request.body, "body");
        const query = parse(definition.query, request.query, "query");
        const params = parse(definition.params, request.params, "params");

        // --- Public route: no session, no tenant transaction ----------------
        if (definition.auth === false) {
          const result = await definition.handler({
            body, query, params,
            ctx: context,
            request,
            reply,
          } as Parameters<typeof definition.handler>[0]);
          logCompletion(request, started, reply.statusCode);
          return send(reply, definition, result);
        }

        // --- Authenticate ---------------------------------------------------
        const cookie = request.cookies[SESSION_COOKIE];
        const session = await resolveSession(cookie);
        if (!session) {
          // Clear a cookie that no longer resolves, so the browser stops sending it.
          reply.clearCookie(SESSION_COOKIE, { path: "/" });
          throw unauthorized();
        }

        context.clinicId = session.user.clinicId;
        context.userId = session.user.id;
        context.role = session.user.role;
        context.capabilities = new Set(session.user.capabilities);
        context.clinicTimezone = session.user.clinic.timezone;

        // --- Authorize ------------------------------------------------------
        const required = definition.auth.capability;
        if (required && !context.capabilities.has(required)) {
          logger.info(
            { correlationId: context.correlationId, role: context.role, required, route: definition.url },
            "Capability denied",
          );
          throw forbidden();
        }

        // --- Tenant transaction ---------------------------------------------
        // Everything the handler does runs inside this, so Postgres row-level
        // security confines it to one clinic and the whole request is atomic.
        const result = await withTenant(
          session.user.clinicId,
          async (tx) => {
            context.tx = tx;
            try {
              return await definition.handler({
                body, query, params,
                ctx: context,
                request,
                reply,
              } as Parameters<typeof definition.handler>[0]);
            } finally {
              context.tx = null;
            }
          },
          { actorUserId: session.user.id },
        );

        logCompletion(request, started, reply.statusCode);
        return send(reply, definition, result);
      });
    },
  });
}

function send(reply: FastifyReply, definition: { method: HTTPMethods; status?: number }, result: unknown) {
  // A handler that wrote to the reply itself (redirect, file) has already sent.
  if (reply.sent) return reply;
  const status = definition.status ?? (definition.method === "POST" && result !== undefined ? 201 : 200);
  if (result === undefined || result === null) return reply.status(204).send();
  return reply.status(status).send(result);
}

function parse<T extends ZodTypeAny | undefined>(
  schema: T,
  value: unknown,
  where: "body" | "query" | "params",
): T extends ZodTypeAny ? z.infer<T> : undefined {
  if (!schema) return undefined as never;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const details = zodDetails(result.error);
    throw badRequest(
      where === "body" ? "Some fields need attention." : `Invalid ${where} parameters.`,
      details,
    );
  }
  return result.data;
}

/**
 * Trust `x-forwarded-for` only for its left-most entry, and only because the API
 * is expected to sit behind a load balancer. Used for rate limiting and audit,
 * never for authorization.
 */
function clientIp(request: FastifyRequest): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip ?? null;
}

function logCompletion(request: FastifyRequest, startedAt: number, statusCode: number): void {
  const context = getContext();
  logger.info(
    {
      correlationId: context.correlationId,
      method: request.method,
      route: request.routeOptions?.url,
      statusCode,
      durationMs: Date.now() - startedAt,
      clinicId: context.clinicId,
      userId: context.userId,
    },
    "request",
  );
}
