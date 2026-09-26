import "server-only";
import type { AppointmentDto, ConsultationTypeDto, WorkingHoursDto } from "@skincrm/contracts";
import { apiFetch } from "./api";
import type { CalendarOptions } from "./calendar-view";

export const getCalendarOptions = () => apiFetch<CalendarOptions>("/calendar/options");
export const getConsultationTypes = () => apiFetch<{ items: ConsultationTypeDto[] }>("/consultation-types").then((r) => r.items);
export const getWorkingHours = () => apiFetch<{ items: WorkingHoursDto[] }>("/working-hours").then((r) => r.items);
export const getAppointments = (query: string) => apiFetch<{ items: AppointmentDto[]; timezone: string }>(`/appointments?${query}`);
