import Link from "next/link";
import type { FeedbackDestinationDto, FeedbackEventDto } from "@skincrm/contracts";
import { PageHeader } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { can, requireCapability } from "@/lib/session";
import { DestinationCard, EventLog } from "./client";

export const metadata = { title: "Ad platform feedback — SkinCRM" };

export interface FeedbackOverview {
  globallyEnabled: boolean;
  modes: { meta: "mock" | "live"; google: "mock" | "live" };
  destinations: FeedbackDestinationDto[];
  volume: { destination: string; milestone: string; state: string; n: number }[];
  events: FeedbackEventDto[];
}

export default async function FeedbackPage() {
  const session = await requireCapability("feedback:read");
  const data = await apiFetch<FeedbackOverview>("/feedback");
  const writable = can(session, "feedback:write");
  return (
    <>
      <Link href="/settings" className="text-sm text-ink-muted hover:text-ink">← Settings</Link>
      <PageHeader
        title="Ad platform feedback"
        description="Tell Facebook or Google when a lead from their ad turns into a booking or a client, so your ads learn which people become real patients — not just who fills in a form."
      />
      <div className="mb-4 rounded-card border border-line bg-surface p-4 text-sm leading-relaxed text-ink-muted">
        <p className="font-medium text-ink">What gets sent — and what never does</p>
        <p className="mt-1">
          Only the milestone (for example &ldquo;QualifiedLead&rdquo;), when it happened, and the platform&rsquo;s own ID for the ad
          response. <strong className="text-ink">Never</strong> names, phone numbers, emails, treatments, conditions or notes. Everything
          is off until you complete the checks and a test for each platform.
        </p>
        {!data.globallyEnabled && (
          <p className="mt-2 rounded-lg bg-caution-soft px-3 py-2 text-caution">
            Sending is switched off for this installation (CONVERSION_FEEDBACK_ENABLED). You can set everything up; nothing leaves until your technical contact turns it on.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-4">
        {data.destinations.map((d) => (
          <DestinationCard
            key={d.destination}
            dest={d}
            writable={writable}
            demo={data.modes[d.destination] === "mock"}
            volume={data.volume.filter((v) => v.destination === d.destination)}
          />
        ))}
        <EventLog events={data.events} />
      </div>
    </>
  );
}
