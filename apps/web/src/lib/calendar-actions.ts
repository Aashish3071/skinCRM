"use server";

import { revalidatePath } from "next/cache";
import type { AppointmentDto, AvailabilitySlot, CreateAppointment, RescheduleAppointment, SetAppointmentStatus, CreateConsultationType, SetWorkingHours, PersonDto } from "@skincrm/contracts";
import { uuidSchema } from "@skincrm/contracts";
import { ApiError, apiFetch } from "./api";

export type CalendarResult<T> = { ok: true; data: T } | { ok: false; message: string; conflict?: boolean };
export type Availability = { date: string; timezone: string; durationMinutes: number; slots: AvailabilitySlot[] };

async function run<T>(work: () => Promise<T>): Promise<CalendarResult<T>> {
  try { return { ok: true, data: await work() }; }
  catch (error) {
    return { ok: false, message: error instanceof ApiError ? error.message : "Could not reach the server. Try again.", conflict: error instanceof ApiError && error.status === 409 };
  }
}

function refresh(visit?: AppointmentDto) {
  revalidatePath("/calendar");
  revalidatePath("/home");
  revalidatePath("/leads");
  if (visit?.leadId) revalidatePath(`/leads/${visit.leadId}`);
  if (visit?.personId) revalidatePath(`/people/${visit.personId}`);
}

export async function loadAvailability(input: { date: string; staffUserId: string; consultationTypeId?: string; rescheduleAppointmentId?: string }): Promise<CalendarResult<Availability>> {
  return run(() => apiFetch<Availability>(`/availability?${new URLSearchParams(Object.entries(input).filter(([, v]) => Boolean(v)) as [string, string][])}`));
}

export async function searchBookingPeople(search: string): Promise<CalendarResult<{ items: PersonDto[] }>> {
  return run(() => apiFetch(`/people?${new URLSearchParams({ search, limit: "15" })}`));
}

export async function bookAppointment(input: CreateAppointment): Promise<CalendarResult<AppointmentDto>> {
  const result = await run(() => apiFetch<AppointmentDto>("/appointments", { method: "POST", body: input }));
  if (result.ok) refresh(result.data);
  return result;
}

export async function moveAppointment(id: string, input: RescheduleAppointment): Promise<CalendarResult<AppointmentDto>> {
  if (!uuidSchema.safeParse(id).success) return { ok: false, message: "Invalid appointment." };
  const result = await run(() => apiFetch<AppointmentDto>(`/appointments/${id}/reschedule`, { method: "POST", body: input }));
  if (result.ok) refresh(result.data);
  return result;
}

export async function cancelAppointment(id: string, reason: string): Promise<CalendarResult<AppointmentDto>> {
  if (!uuidSchema.safeParse(id).success) return { ok: false, message: "Invalid appointment." };
  const result = await run(() => apiFetch<AppointmentDto>(`/appointments/${id}/cancel`, { method: "POST", body: { reason } }));
  if (result.ok) refresh(result.data);
  return result;
}

export async function setAppointmentStatus(id: string, status: SetAppointmentStatus["status"]): Promise<CalendarResult<AppointmentDto>> {
  if (!uuidSchema.safeParse(id).success) return { ok: false, message: "Invalid appointment." };
  const result = await run(() => apiFetch<AppointmentDto>(`/appointments/${id}/status`, { method: "POST", body: { status } }));
  if (result.ok) refresh(result.data);
  return result;
}

export async function saveConsultationType(id: string | null, input: CreateConsultationType): Promise<CalendarResult<unknown>> {
  if (id && !uuidSchema.safeParse(id).success) return { ok: false, message: "Invalid consultation type." };
  const result = await run(() => apiFetch(id ? `/consultation-types/${id}` : "/consultation-types", { method: id ? "PATCH" : "POST", body: input }));
  if (result.ok) { revalidatePath("/settings/calendar"); revalidatePath("/calendar"); }
  return result;
}

export async function saveWorkingHours(input: SetWorkingHours): Promise<CalendarResult<unknown>> {
  const result = await run(() => apiFetch("/working-hours", { method: "PUT", body: input }));
  if (result.ok) { revalidatePath("/settings/calendar"); revalidatePath("/calendar"); }
  return result;
}
