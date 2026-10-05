import type { Metadata } from "next";
import type { PublicBookingInfo } from "@skincrm/contracts";
import { ApiError, apiFetch } from "@/lib/api";
import { LegalFooter } from "@/components/legal";
import { BookingFlow } from "./flow";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string): Promise<PublicBookingInfo | null> {
  try {
    return await apiFetch<PublicBookingInfo>(`/public/booking/${encodeURIComponent(slug)}`, { anonymous: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const info = await load((await params).slug);
  return { title: info ? `Book an appointment — ${info.clinicName}` : "Online booking" };
}

/** The clinic's public booking page (D-92). No sign-in. */
export default async function BookPage({ params }: Props) {
  const { slug } = await params;
  const info = await load(slug);
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      {info ? (
        <>
          <header className="mb-6 flex items-center gap-3">
            {info.hasLogo && <img src={`/book/${slug}/logo`} alt="" width={48} height={48} className="h-12 w-12 rounded-lg object-contain" />}
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Book an appointment</h1>
              <p className="text-sm text-ink-muted">{info.clinicName}{info.clinicPhone ? ` · ${info.clinicPhone}` : ""}</p>
            </div>
          </header>
          {info.types.length === 0 ? (
            <p className="rounded-card border border-line bg-surface p-6 text-sm">Online booking isn&rsquo;t open right now. Please call the clinic.</p>
          ) : (
            <BookingFlow slug={slug} info={info} />
          )}
        </>
      ) : (
        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-xl font-semibold">Online booking isn&rsquo;t available</h1>
          <p className="mt-2 text-sm text-ink-muted">This clinic doesn&rsquo;t take bookings online. Please contact them directly.</p>
        </div>
      )}
      <LegalFooter />
    </main>
  );
}
