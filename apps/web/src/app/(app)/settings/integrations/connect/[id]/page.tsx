import Link from "next/link";
import type { OAuthPendingDto } from "@skincrm/contracts";
import { Card, PageHeader } from "@/components/ui";
import { ApiError, apiFetch } from "@/lib/api";
import { requireCapability } from "@/lib/session";
import { ChooseAccount } from "./choose";

export const metadata = { title: "Finish connecting — SkinCRM" };

const COPY = {
  meta: { title: "Choose your Facebook Page", noun: "Page", help: "Leads from lead forms on this Page will arrive in SkinCRM. Instagram lead ads run through the same Page." },
  google: { title: "Choose your Google Ads account", noun: "ad account", help: "SkinCRM will add itself to every lead form in this account, so new leads arrive automatically." },
} as const;

export default async function ConnectPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability("integrations:write");
  const { id } = await params;
  let pending: OAuthPendingDto | null = null;
  try {
    pending = await apiFetch<OAuthPendingDto>(`/integrations/oauth/pending/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }

  return (
    <>
      <Link href="/settings/integrations" className="text-sm text-ink-muted hover:text-ink">← Lead sources & messaging</Link>
      {pending ? (
        <>
          <PageHeader title={COPY[pending.provider].title} description={COPY[pending.provider].help} />
          <Card>
            <ChooseAccount pendingId={pending.id} provider={pending.provider} noun={COPY[pending.provider].noun} choices={pending.choices} />
          </Card>
        </>
      ) : (
        <>
          <PageHeader title="This request has expired" description="For security, a sign-in is only valid for 15 minutes and can be used once." />
          <Link href="/settings/integrations" className="text-sm font-medium text-brand">Start again</Link>
        </>
      )}
    </>
  );
}
