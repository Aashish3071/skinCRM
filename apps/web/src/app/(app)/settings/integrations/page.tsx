import Link from "next/link";
import type { IntegrationsOverview } from "@skincrm/contracts";
import { Badge, Card, PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { can, requireCapability } from "@/lib/session";
import { GoogleCard, MetaCard, SendingCard, WhatsAppCard, RetryInboundButton } from "./cards";

export const metadata = { title: "Lead sources & messaging — SkinCRM" };

const EVENT_LABEL: Record<string, string> = {
  meta_leadgen: "Facebook/Instagram lead",
  google_lead: "Google Ads lead",
  whatsapp_message: "WhatsApp message",
  whatsapp_status: "WhatsApp delivery update",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const connected = one(params.connected);
  const oauthError = one(params.oauth_error);
  const detail = one(params.detail);
  const session = await requireCapability("integrations:read");
  const data = await apiFetch<IntegrationsOverview>("/integrations");
  const by = (p: string) => data.connections.find((c) => c.provider === p);
  const writable = can(session, "integrations:write");

  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader title="Lead sources & messaging" description="Connect your ad accounts and WhatsApp number, and control what the CRM sends." />
      {!writable && <p className="mb-4 text-sm text-ink-muted">Only an admin can change these.</p>}
      {(connected === "meta" || connected === "google") && (
        <p role="status" className="mb-4 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive">
          <strong>{connected === "meta" ? "Facebook connected." : "Google Ads connected."}</strong> {detail}
        </p>
      )}
      {oauthError && <p role="alert" className="mb-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">{oauthError}</p>}
      <div className="mb-4 rounded-card border border-line bg-surface p-4 text-sm">
        <p>Ad enquiries arrive automatically after connecting. To send bookings and client outcomes back, <Link href="/settings/feedback" className="font-medium text-brand">set up ad platform feedback</Link> and test each channel.</p>
        <p className="mt-1 text-ink-muted">New Google lead forms are checked hourly. Messages and lead submissions keep their original provider IDs to prevent duplicates.</p>
      </div>
      <div className="flex flex-col gap-4">
        <SendingCard sending={data.sending} modes={data.modes} />
        <MetaCard connection={by("meta_lead_ads")} webhook={data.webhooks.meta} verifyToken={data.verifyTokens.meta} live={data.modes.meta === "live"} />
        <GoogleCard connection={by("google_lead_forms")} webhook={data.webhooks.google} live={data.modes.google === "live"} />
        <WhatsAppCard connection={by("whatsapp_cloud")} webhook={data.webhooks.whatsapp} verifyToken={data.verifyTokens.whatsapp} live={data.modes.whatsapp === "live"} />

        <Card title="Recently received" description="The last 30 things your connected accounts sent in.">
          {data.events.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {data.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-medium">{EVENT_LABEL[e.type]}</span>
                  {e.isTest && <Badge>Test</Badge>}
                  <span className="text-ink-subtle">{relativeTime(e.receivedAt)}</span>
                  <span className="ml-auto">
                    {e.state === "processed" ? (
                      e.result?.startsWith("lead:") ? <Link href={`/leads/${e.result.slice(5)}`} className="text-brand">Open lead</Link> : <Badge tone="positive">Done</Badge>
                    ) : e.state === "pending" ? (
                      <Badge tone="caution">{e.attempts ? `Retrying (${e.attempts})` : "Waiting"}</Badge>
                    ) : (
                      <Badge tone="critical">Failed</Badge>
                    )}
                  </span>
                  {writable && e.state === "failed" && <RetryInboundButton id={e.id} />}
                  {e.lastError && e.state !== "processed" && <p className="w-full text-xs text-critical">{e.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
