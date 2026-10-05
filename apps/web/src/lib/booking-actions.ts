"use server";

import type { PublicAppointment, PublicSlots } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

/**
 * The patient-facing booking pages (D-92). Anonymous calls: the clinic slug or
 * the signed manage link is the only authority, checked by the API.
 */
export type Outcome<T> = { ok: true; data: T } | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

async function call<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<Outcome<T>> {
  try {
    return { ok: true, data: await apiFetch<T>(path, { ...options, anonymous: true }) };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message, fieldErrors: error.details };
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

const enc = encodeURIComponent;

export async function bookingSlotsAction(slug: string, typeId: string, date: string) {
  return call<PublicSlots>(`/public/booking/${enc(slug)}/slots?typeId=${enc(typeId)}&date=${enc(date)}`);
}

export async function bookAction(slug: string, body: Record<string, unknown>) {
  return call<PublicAppointment>(`/public/booking/${enc(slug)}`, { method: "POST", body });
}

export async function manageSlotsAction(token: string, date: string) {
  return call<PublicSlots>(`/public/appointments/${enc(token)}/slots?date=${enc(date)}`);
}

export async function rescheduleAction(token: string, startsAt: string) {
  return call<PublicAppointment>(`/public/appointments/${enc(token)}/reschedule`, { method: "POST", body: { startsAt } });
}

export async function cancelAction(token: string, reason: string) {
  return call<PublicAppointment>(`/public/appointments/${enc(token)}/cancel`, { method: "POST", body: { reason } });
}
