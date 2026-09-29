import { NextResponse, type NextRequest } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * Facebook / Google send the browser back here after sign-in. The code and
 * state go to the API (which checks the state belongs to this person and
 * clinic); the person then picks a Page or ad account on the connect screen.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const back = (query: Record<string, string>) =>
    NextResponse.redirect(new URL(`/settings/integrations?${new URLSearchParams(query)}`, request.url));
  if (provider !== "meta" && provider !== "google") return back({ oauth_error: "Unknown provider." });

  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Both providers send error=access_denied when the person presses Cancel.
  if (url.searchParams.get("error") || !code || !state) {
    return back({ oauth_error: url.searchParams.get("error") === "access_denied" ? "You cancelled the sign-in, so nothing was connected." : "The sign-in didn't finish. Try again." });
  }
  try {
    const { pendingId } = await apiFetch<{ pendingId: string }>(`/integrations/oauth/${provider}/callback`, { method: "POST", body: { code, state } });
    return NextResponse.redirect(new URL(`/settings/integrations/connect/${encodeURIComponent(pendingId)}`, request.url));
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) return NextResponse.redirect(new URL("/login", request.url));
    return back({ oauth_error: error instanceof ApiError ? error.message : "The sign-in didn't finish. Try again." });
  }
}
