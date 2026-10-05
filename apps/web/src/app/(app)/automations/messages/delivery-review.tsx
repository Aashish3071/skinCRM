"use client";
import { clinicTime } from "@/lib/format";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveDeliveryAction } from "@/lib/delivery-actions";
export type Receipt = {
  id: string;
  personName: string | null;
  channel: string;
  state: string;
  providerMessageId: string | null;
  createdAt: string;
};
export function DeliveryReview({
  receipts,
  timezone,
}: {
  receipts: Receipt[];
  timezone: string;
}) {
  const [notice, setNotice] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!receipts.length) return null;
  return (
    <section className="mb-5 rounded border border-amber-400 bg-amber-50 p-4">
      <h2 className="font-semibold">Delivery needs review</h2>
      <p className="mb-3 text-sm">
        These sends were interrupted. Check the email or WhatsApp provider's
        delivery history before recording an outcome. This screen never resends
        a message. Showing up to 100 receipts.
      </p>
      {receipts.map((r) => (
        <div key={r.id} className="my-3 rounded border bg-white p-3">
          <p>
            {r.personName ?? "Patient record unavailable"} · {r.channel} ·{" "}
            {clinicTime(r.createdAt, timezone)}
          </p>
          {r.state === "accepted" ? (
            <p>
              Provider accepted: {r.providerMessageId}. The worker will restore
              the delivery log when the patient record is available.
            </p>
          ) : (
            <div className="mt-2 flex gap-4">
              {(["accepted", "not_sent"] as const).map((outcome) => (
                <button
                  key={outcome}
                  disabled={pending}
                  onClick={() => {
                    const providerMessageId =
                      outcome === "accepted"
                        ? prompt(
                            "Provider message ID from the confirmed delivery record",
                          )
                        : null;
                    if (outcome === "accepted" && !providerMessageId) return;
                    const reason = prompt(
                      "Describe the provider evidence you checked (at least 10 characters). Do not include patient or message details.",
                    );
                    if (!reason) return;
                    start(async () => {
                      const result = await resolveDeliveryAction(
                        r.id,
                        outcome === "accepted"
                          ? {
                              outcome,
                              providerMessageId: providerMessageId!,
                              reason,
                            }
                          : { outcome, reason },
                      );
                      setNotice(
                        result.ok
                          ? "Delivery outcome recorded."
                          : result.message,
                      );
                      if (result.ok) router.refresh();
                    });
                  }}
                >
                  {outcome === "accepted"
                    ? "Confirm provider accepted"
                    : "Confirm not sent"}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
