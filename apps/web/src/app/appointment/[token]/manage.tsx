"use client";

import { useState, useTransition } from "react";
import type { PublicAppointment } from "@skincrm/contracts";
import { SlotPicker, formatDay, formatTime } from "@/components/slot-picker";
import { Field, buttonClasses, inputClasses } from "@/components/ui";
import { cancelAction, manageSlotsAction, rescheduleAction } from "@/lib/booking-actions";

const STATUS_TEXT: Record<PublicAppointment["status"], string> = {
  scheduled: "Booked",
  confirmed: "Confirmed",
  attended: "Completed",
  no_show: "Missed",
  canceled: "Cancelled",
  rescheduled: "Moved",
};

export function ManageAppointment({ initial }: { initial: PublicAppointment }) {
  const [appt, setAppt] = useState(initial);
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const tz = appt.timezone;
  const call = appt.clinicPhone ? ` on ${appt.clinicPhone}` : "";

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card border border-line bg-surface p-6">
        <p className="text-sm text-ink-muted">{appt.clinicName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{appt.typeName ?? "Your appointment"}</h1>
        <p className="mt-3 text-[15px]">
          <strong>{formatDay(appt.startsAt, tz)}</strong> at <strong>{formatTime(appt.startsAt, tz)}</strong>
          <span className="text-ink-muted"> – {formatTime(appt.endsAt, tz)} ({tz.replace(/_/g, " ")})</span>
        </p>
        <p className="mt-2 inline-block rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium">{STATUS_TEXT[appt.status]}</p>
        {appt.canChange ? (
          <p className="mt-3 text-sm text-ink-muted">You can move or cancel online until {formatDay(appt.changeDeadline, tz, "short")}, {formatTime(appt.changeDeadline, tz)}.</p>
        ) : appt.status === "scheduled" || appt.status === "confirmed" ? (
          <p className="mt-3 text-sm text-ink-muted">To change this appointment now, please call {appt.clinicName}{call}.</p>
        ) : null}
        {message && <p role={message.ok ? "status" : "alert"} className={`mt-4 rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-positive-soft text-positive" : "bg-critical-soft text-critical"}`}>{message.text}</p>}
        {appt.canChange && mode === "view" && (
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => { setMode("move"); setMessage(null); }} className={buttonClasses()}>Change time</button>
            <button type="button" onClick={() => { setMode("cancel"); setMessage(null); }} className={buttonClasses("danger")}>Cancel appointment</button>
          </div>
        )}
      </section>

      {mode === "move" && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h2 className="mb-3 text-base font-semibold">Pick a new time</h2>
          <SlotPicker timezone={tz} value={startsAt} onChange={setStartsAt} load={(date) => manageSlotsAction(appt.manageToken, date)} />
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={!startsAt || pending} className={buttonClasses()}
              onClick={() => start(async () => {
                const r = await rescheduleAction(appt.manageToken, startsAt!);
                if (!r.ok) return setMessage({ ok: false, text: r.message });
                setAppt(r.data);
                setMode("view");
                setStartsAt(null);
                setMessage({ ok: true, text: "Done — your appointment has moved. We'll send you the new details." });
                // Keep the address bar on the newest link.
                window.history.replaceState(null, "", `/appointment/${r.data.manageToken}`);
              })}>
              {pending ? "Moving…" : "Move my appointment"}
            </button>
            <button type="button" onClick={() => setMode("view")} className={buttonClasses("ghost")}>Keep current time</button>
          </div>
        </section>
      )}

      {mode === "cancel" && (
        <form className="rounded-card border border-line bg-surface p-5" onSubmit={(e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
          start(async () => {
            const r = await cancelAction(appt.manageToken, reason);
            if (!r.ok) return setMessage({ ok: false, text: r.message });
            setAppt(r.data);
            setMode("view");
            setMessage({ ok: true, text: "Your appointment is cancelled. You can book again any time." });
          });
        }}>
          <h2 className="text-base font-semibold">Cancel this appointment?</h2>
          <div className="mt-3"><Field label="Reason (optional)" htmlFor="c-reason" hint="Please don't include medical details."><textarea id="c-reason" name="reason" rows={2} maxLength={500} className={inputClasses} /></Field></div>
          <div className="mt-4 flex gap-2">
            <button disabled={pending} className={buttonClasses("danger")}>{pending ? "Cancelling…" : "Yes, cancel it"}</button>
            <button type="button" onClick={() => setMode("view")} className={buttonClasses("ghost")}>Keep it</button>
          </div>
        </form>
      )}
    </div>
  );
}
