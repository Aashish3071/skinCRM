import { ApiError, apiFetch } from "@/lib/api";
import { UnsubscribeButton } from "./button";

export const metadata = { title: "Unsubscribe", robots: { index: false } };

/**
 * Public page reached from the link at the bottom of a marketing message.
 * No sign-in. Says which clinic, never who — anyone holding a forwarded email
 * holds this link.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let info: { clinicName: string; channel: string; unsubscribed: boolean } | null = null;
  try {
    info = await apiFetch(`/public/unsubscribe/${encodeURIComponent(token)}`, { anonymous: true });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-card border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
        {!info ? (
          <>
            <h1 className="text-xl font-semibold">This link doesn&rsquo;t work</h1>
            <p className="mt-2 text-sm text-ink-muted">
              It may have been copied incompletely. Reply to the message you received and ask to be removed, and the
              clinic will do it for you.
            </p>
          </>
        ) : (
          <UnsubscribeButton token={token} clinicName={info.clinicName} channel={info.channel} already={info.unsubscribed} />
        )}
      </div>
    </main>
  );
}
