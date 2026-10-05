import type { PublicAppointment } from "@skincrm/contracts";
import { ApiError, apiFetch } from "@/lib/api";
import { LegalFooter } from "@/components/legal";
import { ManageAppointment } from "./manage";

export const metadata = { title: "Your appointment" };

/** A patient's signed link to see, move or cancel one appointment (D-92). */
export default async function AppointmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let appointment: PublicAppointment | null = null;
  try {
    appointment = await apiFetch<PublicAppointment>(`/public/appointments/${encodeURIComponent(token)}`, { anonymous: true });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      {appointment ? (
        <ManageAppointment initial={appointment} />
      ) : (
        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-xl font-semibold">This link isn&rsquo;t valid</h1>
          <p className="mt-2 text-sm text-ink-muted">Please contact the clinic to check or change your appointment.</p>
        </div>
      )}
      <LegalFooter />
    </main>
  );
}
