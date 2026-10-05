import { z } from "zod";
import { isoDate } from "./common";
import { LEAD_SOURCES } from "./enums";

/** Reporting (PRD REP-01…04). Every number excludes test leads. */

export const reportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  source: z.enum(LEAD_SOURCES).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface FunnelStep {
  key: "new" | "contacted" | "qualified" | "visited" | "won";
  label: string;
  hint: string;
  count: number;
  /** Share of all leads in the period. */
  ofTotal: number;
  /** Share of the previous step. */
  ofPrevious: number;
}

export interface SourceRow {
  source: string;
  label: string;
  leads: number;
  qualified: number;
  visited: number;
  won: number;
  lost: number;
}

export interface CampaignRow {
  platform: string;
  campaign: string;
  campaignId: string | null;
  leads: number;
  qualified: number;
  won: number;
  /** Ad spend in the range, from the connected ad account (D-95); null when not synced. */
  spendMicros: number | null;
  currency: string | null;
}

export interface ReportSummary {
  range: { from: string; to: string; timezone: string };
  funnel: FunnelStep[];
  lost: number;
  sources: SourceRow[];
  campaigns: CampaignRow[];
  trend: { day: string; leads: number; qualified: number }[];
  operations: {
    medianMinutesToFirstContact: number | null;
    contactedWithinHour: number;
    unassignedOpen: number;
    overdueTasks: number;
    appointmentsBooked: number;
    attended: number;
    noShows: number;
    noShowRate: number | null;
    messagesSent: number;
    messagesNotSent: number;
    openConversations: number;
  };
}
