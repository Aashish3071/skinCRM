import { ConnectorError } from "./types";

/** Meta Graph API version used by every Meta adapter. Bump in one place. */
export const GRAPH_VERSION = "v21.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Call the Graph API and turn its error envelope into a ConnectorError with
 * the right retry decision. Tokens travel in the Authorization header, never
 * the URL, so they cannot end up in a proxy or access log.
 */
export async function graphRequest<T>(
  fetchImpl: FetchLike,
  path: string,
  token: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH_BASE}/${path.replace(/^\//, "")}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ConnectorError(`Could not reach Meta: ${error instanceof Error ? error.message : "network error"}`, {
      retryable: true,
      providerCode: "network",
    });
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const err = (data as { error?: { message?: string; code?: number; error_subcode?: number } }).error;
    const code = err?.code;
    throw new ConnectorError(err?.message ?? `Meta returned ${response.status}`, {
      definitelyNotSent: response.status < 500,
      // Rate limits and Meta-side outages are worth retrying; bad tokens and
      // bad requests are not.
      retryable: response.status >= 500 || code === 4 || code === 17 || code === 32 || code === 613 || code === 130429,
      providerCode: code !== undefined ? String(code) : String(response.status),
      // 131026: the number is not on WhatsApp / cannot receive messages.
      permanentSuppression: code === 131026,
    });
  }
  return data as T;
}
