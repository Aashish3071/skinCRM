import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { tryGetContext } from "./context";
import { logger } from "./logger";

/**
 * Every non-2xx response uses one envelope:
 *   { error: { code, message, details?, correlationId } }
 *
 * `code` is a stable machine-readable string the web app switches on; `message`
 * is safe to show a user. Driver messages, stack traces and SQL never reach the
 * client — they go to the log, keyed by the same correlation id.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    /**
     * Extra top-level keys merged into the response alongside `error`. Used
     * where the client needs data to act on the failure — for example the
     * duplicate candidates that come back with a 409 from person creation, so
     * the UI can offer "use this record" instead of making the user search.
     */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError(400, "bad_request", message, details);

export const unauthorized = (message = "Sign in to continue.") =>
  new AppError(401, "unauthorized", message);

/**
 * Deliberately vague. Confirming that a record exists but is off-limits is
 * itself a disclosure, so a forbidden capability and a foreign record both
 * surface the same way.
 */
export const forbidden = (message = "You do not have access to this.") =>
  new AppError(403, "forbidden", message);

export const notFound = (message = "Not found.") => new AppError(404, "not_found", message);

export const conflict = (message: string, details?: Record<string, string[]>) =>
  new AppError(409, "conflict", message, details);

export const tooManyRequests = (message = "Too many attempts. Try again shortly.") =>
  new AppError(429, "rate_limited", message);

export const unprocessable = (message: string, details?: Record<string, string[]>) =>
  new AppError(422, "unprocessable", message, details);

/** Turn a Zod error into `details` keyed by dotted field path. */
export function zodDetails(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = tryGetContext()?.correlationId ?? request.id;

    if (error instanceof AppError) {
      // Expected outcomes: log at info so they do not drown real failures.
      logger.info(
        { correlationId, code: error.code, statusCode: error.statusCode, route: request.routeOptions?.url },
        error.message,
      );
      return reply.status(error.statusCode).send({
        ...(error.extra ?? {}),
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          correlationId,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_failed",
          message: "Some fields need attention.",
          details: zodDetails(error),
          correlationId,
        },
      });
    }

    // Fastify's own errors (body too large, malformed JSON, rate limit).
    const fastifyStatus = (error as { statusCode?: number } | null)?.statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500) {
      const message = (error as Error).message || "Request could not be processed.";
      logger.info({ correlationId, statusCode: fastifyStatus }, message);
      return reply.status(fastifyStatus).send({
        error: { code: "bad_request", message, correlationId },
      });
    }

    // Anything else is a bug. Log it in full; tell the client nothing.
    logger.error(
      {
        correlationId,
        route: request.routeOptions?.url,
        method: request.method,
        err: serializeError(error),
      },
      "Unhandled error",
    );
    return reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Something went wrong on our side. The reference below will help us trace it.",
        correlationId,
      },
    });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = tryGetContext()?.correlationId ?? request.id;
    return reply.status(404).send({
      error: { code: "not_found", message: "No such endpoint.", correlationId },
    });
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}
