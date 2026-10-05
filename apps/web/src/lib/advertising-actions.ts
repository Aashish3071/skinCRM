"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch } from "./api";

export type AdResult = { ok: true; detail?: string } | { ok: false; message: string };
type Platform = "meta" | "google";

async function run(work: () => Promise<string | void>): Promise<AdResult> {
  try {
    const detail = (await work()) ?? undefined;
    revalidatePath("/settings/advertising");
    return { ok: true, detail };
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.details ? Object.values(error.details).flat()[0] : undefined;
      return { ok: false, message: field ?? error.message };
    }
    return { ok: false, message: "Could not reach the server." };
  }
}

export async function loadMetaAccountsAction(): Promise<{ ok: true; items: { id: string; name: string; currency: string }[] } | { ok: false; message: string }> {
  try {
    return { ok: true, items: (await apiFetch<{ items: { id: string; name: string; currency: string }[] }>("/advertising/meta/accounts")).items };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server." };
  }
}

export async function chooseMetaAccountAction(accountId: string) {
  return run(async () => { await apiFetch("/advertising/meta/account", { method: "PUT", body: { accountId } }); });
}

export async function setCampaignActiveAction(platform: Platform, campaignId: string, active: boolean) {
  return run(async () => {
    await apiFetch(`/advertising/${platform}/campaigns/${campaignId}/status`, { method: "POST", body: { active } });
    return active ? "Campaign resumed." : "Campaign paused.";
  });
}

export async function setBudgetAction(platform: Platform, campaignId: string, dailyBudget: number) {
  return run(async () => {
    await apiFetch(`/advertising/${platform}/campaigns/${campaignId}/budget`, { method: "POST", body: { dailyBudget } });
    return "Daily budget updated.";
  });
}

export async function syncSpendAction(platform: Platform) {
  return run(async () => `Spend refreshed (${(await apiFetch<{ rows: number }>(`/advertising/${platform}/sync-spend`, { method: "POST" })).rows} campaign-days).`);
}

export async function importLeadsAction(platform: Platform, days: number) {
  return run(async () => {
    const r = await apiFetch<{ queued: number; alreadyHad: number }>(`/advertising/${platform}/import-leads`, { method: "POST", body: { days } });
    return `${r.queued} past ${r.queued === 1 ? "lead" : "leads"} importing now${r.alreadyHad ? `; ${r.alreadyHad} already in SkinCRM` : ""}. They arrive in Leads within a minute, without welcome messages.`;
  });
}

export async function createAudienceAction(input: { platform: Platform; segment: string; name: string }) {
  return run(async () => {
    const r = await apiFetch<{ members: number }>("/advertising/audiences", { method: "POST", body: input });
    return `Audience created with ${r.members} ${r.members === 1 ? "person" : "people"}. It stays in step daily.`;
  });
}

export async function syncAudienceAction(id: string) {
  return run(async () => `Audience updated: ${(await apiFetch<{ members: number }>(`/advertising/audiences/${id}/sync`, { method: "POST" })).members} people.`);
}

export async function deleteAudienceAction(id: string) {
  return run(async () => { await apiFetch(`/advertising/audiences/${id}`, { method: "DELETE" }); return "Audience deleted from the ad platform."; });
}
