import { ConnectorError } from "../types";
import type { FetchLike } from "../graph";

/**
 * Staff calendar sync (PRD CAL-07, D-94): Google Calendar and Microsoft 365 /
 * Outlook. Each staff member connects their own calendar. We write their
 * SkinCRM appointments as events and read their other events back as busy
 * times (start/end only — titles are never requested).
 */
export type CalendarProvider = "google" | "microsoft";

export interface CalendarEventInput {
  appointmentId: string;
  title: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
}

export interface BusyBlock {
  externalId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface CalendarClient {
  readonly provider: CalendarProvider;
  readonly mode: "mock" | "live";
  authorizeUrl(params: { state: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; redirectUri: string }): Promise<{ refreshToken: string; accountEmail: string | null }>;
  /** A fresh access token; Microsoft also rotates the refresh token. */
  accessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string }>;
  createEvent(accessToken: string, calendarId: string, event: CalendarEventInput): Promise<string>;
  updateEvent(accessToken: string, calendarId: string, eventId: string, event: CalendarEventInput): Promise<void>;
  /** Already gone counts as deleted. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
  listBusy(accessToken: string, calendarId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

async function json<T>(fetchImpl: FetchLike, url: string, init: RequestInit, label: string): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new ConnectorError(`Could not reach ${label}: ${error instanceof Error ? error.message : "network error"}`, { retryable: true, providerCode: "network" });
  }
  if (response.status === 204) return {} as T;
  const data = (await response.json().catch(() => ({}))) as T & { error?: unknown; error_description?: string };
  if (!response.ok) {
    const err = data.error as { message?: string; code?: string } | string | undefined;
    const message = data.error_description ?? (typeof err === "string" ? err : err?.message) ?? `${label} returned ${response.status}`;
    throw new ConnectorError(message, {
      retryable: response.status >= 500 || response.status === 429,
      providerCode: String(response.status),
    });
  }
  return data;
}

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

// --- Google Calendar ----------------------------------------------------------

export class GoogleCalendarClient implements CalendarClient {
  readonly provider = "google" as const;
  readonly mode = "live" as const;
  constructor(private readonly app: { clientId: string; clientSecret: string }, private readonly fetchImpl: FetchLike = fetch) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email https://www.googleapis.com/auth/calendar.events");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    const t = await json<{ refresh_token?: string; access_token: string }>(this.fetchImpl, "https://oauth2.googleapis.com/token",
      form({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri }), "Google");
    if (!t.refresh_token) throw new ConnectorError("Google didn't return a refresh token. Remove SkinCRM's access in your Google account and connect again.", { retryable: false, providerCode: "oauth" });
    const me = await json<{ email?: string }>(this.fetchImpl, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } }, "Google");
    return { refreshToken: t.refresh_token, accountEmail: me.email ?? null };
  }

  async accessToken(refreshToken: string) {
    const t = await json<{ access_token: string }>(this.fetchImpl, "https://oauth2.googleapis.com/token",
      form({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }), "Google");
    return { accessToken: t.access_token };
  }

  private base(calendarId: string) {
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  private body(e: CalendarEventInput) {
    return JSON.stringify({
      summary: e.title,
      description: e.description,
      start: { dateTime: e.startsAt.toISOString() },
      end: { dateTime: e.endsAt.toISOString() },
      extendedProperties: { private: { skincrmAppointmentId: e.appointmentId } },
    });
  }

  async createEvent(token: string, calendarId: string, e: CalendarEventInput) {
    const r = await json<{ id: string }>(this.fetchImpl, this.base(calendarId), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: this.body(e) }, "Google Calendar");
    return r.id;
  }

  async updateEvent(token: string, calendarId: string, eventId: string, e: CalendarEventInput) {
    await json(this.fetchImpl, `${this.base(calendarId)}/${encodeURIComponent(eventId)}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: this.body(e) }, "Google Calendar");
  }

  async deleteEvent(token: string, calendarId: string, eventId: string) {
    try {
      await json(this.fetchImpl, `${this.base(calendarId)}/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, "Google Calendar");
    } catch (error) {
      if (error instanceof ConnectorError && (error.options.providerCode === "404" || error.options.providerCode === "410")) return;
      throw error;
    }
  }

  async listBusy(token: string, calendarId: string, from: Date, to: Date): Promise<BusyBlock[]> {
    type Item = { id: string; status?: string; transparency?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; extendedProperties?: { private?: Record<string, string> } };
    const out: BusyBlock[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(this.base(calendarId));
      url.searchParams.set("timeMin", from.toISOString());
      url.searchParams.set("timeMax", to.toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "2500");
      // Times and flags only: never titles, attendees or notes.
      url.searchParams.set("fields", "items(id,status,transparency,start,end,extendedProperties),nextPageToken");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const r = await json<{ items?: Item[]; nextPageToken?: string }>(this.fetchImpl, url.toString(), { headers: { authorization: `Bearer ${token}` } }, "Google Calendar");
      for (const item of r.items ?? []) {
        if (item.status === "cancelled" || item.transparency === "transparent") continue;
        if (item.extendedProperties?.private?.skincrmAppointmentId) continue;
        const start = item.start?.dateTime ?? (item.start?.date ? `${item.start.date}T00:00:00Z` : null);
        const end = item.end?.dateTime ?? (item.end?.date ? `${item.end.date}T00:00:00Z` : null);
        if (start && end) out.push({ externalId: item.id, startsAt: new Date(start), endsAt: new Date(end) });
      }
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return out;
  }
}

// --- Microsoft 365 / Outlook (Graph) --------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";
const MS_SCOPES = "offline_access openid email User.Read Calendars.ReadWrite";

export class MicrosoftCalendarClient implements CalendarClient {
  readonly provider = "microsoft" as const;
  readonly mode = "live" as const;
  constructor(private readonly app: { clientId: string; clientSecret: string; tenant: string }, private readonly fetchImpl: FetchLike = fetch) {}

  private authority(path: string) {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.app.tenant)}/oauth2/v2.0/${path}`;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const url = new URL(this.authority("authorize"));
    url.searchParams.set("client_id", this.app.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", MS_SCOPES);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    const t = await json<{ refresh_token?: string; access_token: string }>(this.fetchImpl, this.authority("token"),
      form({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: MS_SCOPES }), "Microsoft");
    if (!t.refresh_token) throw new ConnectorError("Microsoft didn't return a refresh token.", { retryable: false, providerCode: "oauth" });
    const me = await json<{ mail?: string | null; userPrincipalName?: string }>(this.fetchImpl, `${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${t.access_token}` } }, "Microsoft");
    return { refreshToken: t.refresh_token, accountEmail: me.mail ?? me.userPrincipalName ?? null };
  }

  async accessToken(refreshToken: string) {
    const t = await json<{ access_token: string; refresh_token?: string }>(this.fetchImpl, this.authority("token"),
      form({ client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken, scope: MS_SCOPES }), "Microsoft");
    return { accessToken: t.access_token, refreshToken: t.refresh_token };
  }

  private body(e: CalendarEventInput) {
    // Graph wants a local date-time plus a zone; UTC keeps it unambiguous.
    const utc = (d: Date) => d.toISOString().replace("Z", "");
    return JSON.stringify({
      subject: e.title,
      body: { contentType: "text", content: e.description },
      start: { dateTime: utc(e.startsAt), timeZone: "UTC" },
      end: { dateTime: utc(e.endsAt), timeZone: "UTC" },
      categories: ["SkinCRM"],
      showAs: "busy",
    });
  }

  async createEvent(token: string, _calendarId: string, e: CalendarEventInput) {
    const r = await json<{ id: string }>(this.fetchImpl, `${GRAPH}/me/calendar/events`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: this.body(e) }, "Outlook");
    return r.id;
  }

  async updateEvent(token: string, _calendarId: string, eventId: string, e: CalendarEventInput) {
    await json(this.fetchImpl, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: this.body(e) }, "Outlook");
  }

  async deleteEvent(token: string, _calendarId: string, eventId: string) {
    try {
      await json(this.fetchImpl, `${GRAPH}/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }, "Outlook");
    } catch (error) {
      if (error instanceof ConnectorError && (error.options.providerCode === "404" || error.options.providerCode === "410")) return;
      throw error;
    }
  }

  async listBusy(token: string, _calendarId: string, from: Date, to: Date): Promise<BusyBlock[]> {
    type Item = { id: string; showAs?: string; isCancelled?: boolean; categories?: string[]; start: { dateTime: string }; end: { dateTime: string } };
    const out: BusyBlock[] = [];
    let url: string | undefined = `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=id,showAs,isCancelled,categories,start,end&$top=500`;
    for (let page = 0; url && page < 20; page++) {
      const r: { value?: Item[]; "@odata.nextLink"?: string } = await json(this.fetchImpl, url, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' } }, "Outlook");
      for (const item of r.value ?? []) {
        if (item.isCancelled || item.categories?.includes("SkinCRM")) continue;
        if (!["busy", "oof", "tentative"].includes(item.showAs ?? "busy")) continue;
        out.push({ externalId: item.id, startsAt: new Date(`${item.start.dateTime.replace(/Z?$/, "Z")}`), endsAt: new Date(`${item.end.dateTime.replace(/Z?$/, "Z")}`) });
      }
      url = r["@odata.nextLink"];
    }
    return out;
  }
}

// --- Demo ------------------------------------------------------------------

/** No sign-in; an in-memory calendar per refresh token. Tests can add busy blocks. */
export class MockCalendarClient implements CalendarClient {
  readonly mode = "mock" as const;
  readonly events = new Map<string, CalendarEventInput & { id: string }>();
  readonly busy: BusyBlock[] = [];
  constructor(readonly provider: CalendarProvider) {}
  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    const url = new URL(redirectUri);
    url.searchParams.set("code", `mock-${this.provider}-calendar`);
    url.searchParams.set("state", state);
    return `${url.pathname}${url.search}`;
  }
  async exchangeCode({ code }: { code: string }) {
    if (code !== `mock-${this.provider}-calendar`) throw new ConnectorError("Unknown code", { retryable: false, providerCode: "oauth" });
    return { refreshToken: `mock-${this.provider}-refresh`, accountEmail: `demo@${this.provider === "google" ? "gmail.com" : "outlook.com"}` };
  }
  async accessToken() {
    return { accessToken: "mock-access" };
  }
  async createEvent(_t: string, _c: string, e: CalendarEventInput) {
    const id = `evt-${this.events.size + 1}-${e.appointmentId.slice(0, 8)}`;
    this.events.set(id, { ...e, id });
    return id;
  }
  async updateEvent(_t: string, _c: string, id: string, e: CalendarEventInput) {
    this.events.set(id, { ...e, id });
  }
  async deleteEvent(_t: string, _c: string, id: string) {
    this.events.delete(id);
  }
  async listBusy(_t: string, _c: string, from: Date, to: Date) {
    return this.busy.filter((b) => b.endsAt > from && b.startsAt < to);
  }
}
