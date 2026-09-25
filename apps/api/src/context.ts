import { AsyncLocalStorage } from "node:async_hooks";
import type { Capability, UserRole } from "@skincrm/contracts";
import type { TenantDatabase } from "@skincrm/db";

/**
 * Per-request state, carried through AsyncLocalStorage rather than threaded
 * through every function signature.
 *
 * `tx` is the tenant-scoped transaction opened by the tenant hook. Services read
 * it from here, which is what makes it impossible to accidentally run a
 * tenant-scoped query on an unscoped connection: there is no other handle to
 * reach for inside a request.
 */
export interface RequestContext {
  /** Returned on every error response and attached to every log line. */
  correlationId: string;
  /** Set once the session is resolved. Null on public routes. */
  clinicId: string | null;
  userId: string | null;
  role: UserRole | null;
  capabilities: ReadonlySet<Capability>;
  /** Clinic timezone, for formatting clinic-local dates in responses. */
  clinicTimezone: string | null;
  /** Present only inside the tenant transaction. */
  tx: TenantDatabase | null;
  ipAddress: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("No request context. This code must run inside a request or a job wrapper.");
  }
  return context;
}

/** Null outside a request, for code that may run in either place. */
export function tryGetContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The tenant-scoped transaction for the current request. Throws rather than
 * silently falling back to an unscoped connection, because a fallback would
 * defeat row-level security.
 */
export function getTx(): TenantDatabase {
  const { tx } = getContext();
  if (!tx) {
    throw new Error(
      "No tenant transaction on this request. Routes that touch tenant data must declare `auth: true`.",
    );
  }
  return tx;
}

export function createContext(init: Partial<RequestContext> & { correlationId: string }): RequestContext {
  return {
    clinicId: null,
    userId: null,
    role: null,
    capabilities: new Set(),
    clinicTimezone: null,
    tx: null,
    ipAddress: null,
    userAgent: null,
    ...init,
  };
}
