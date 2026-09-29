import "server-only";
import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";

/**
 * Server-side API client.
 *
 * The browser never calls the Fastify API directly. Every request goes through a
 * server component or a Server Action, which forwards the session cookie from
 * `next/headers`. That means:
 *
 *  - the session cookie stays first-party to the web origin,
 *  - there is no CORS surface and no credentialed cross-origin request,
 *  - and the API token never has to be readable by client JavaScript.
 *
 * In production, put the API behind the same origin as the web app (a reverse
 * proxy at `/api`) so this holds there too.
 */

const SESSION_COOKIE = "skincrm_session";

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    correlationId?: string;
  };
}

/** Thrown for any non-2xx response, carrying the API's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the caller should be sent back to sign in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Opt out of forwarding the session cookie, for login and other public calls. */
  anonymous?: boolean;
  /** Next.js cache behaviour. Tenant data is never cached across requests. */
  cache?: RequestCache;
  /** Captures Set-Cookie so a Server Action can re-issue it on its own response. */
  onSetCookie?: (value: string) => void;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const requestHeaders: Record<string, string> = {
    accept: "application/json",
    // Propagate the trace so a web request and its API request share one id.
    "x-correlation-id": (await headers()).get("x-correlation-id") ?? randomUUID(),
  };

  if (options.body !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }

  if (!options.anonymous) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) requestHeaders.cookie = `${SESSION_COOKIE}=${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers: requestHeaders,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      // Never reuse a cached response across users or clinics.
      cache: options.cache ?? "no-store",
    });
  } catch {
    // API down or restarting. Forms show this message; pages fall through to
    // the error screen (app/(app)/error.tsx) with a "Try again" button.
    throw new ApiError(503, "api_unreachable", "SkinCRM's server isn't responding. Wait a moment and try again.");
  }

  const setCookie = response.headers.get("set-cookie");
  if (setCookie && options.onSetCookie) options.onSetCookie(setCookie);

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    const body = payload as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "unknown_error",
      body?.error?.message ?? `Request failed with status ${response.status}`,
      body?.error?.details,
      body?.error?.correlationId,
    );
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export { SESSION_COOKIE };

/** Raw response, for downloads (CSV) the browser should receive unchanged. */
export async function apiRaw(path: string): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return fetch(`${apiBaseUrl()}${path}`, {
    headers: { ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), "x-correlation-id": randomUUID() },
    cache: "no-store",
  });
}
