import { NextResponse, type NextRequest } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

/** Google / Microsoft send the browser back here after calendar sign-in (D-94). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const back = (query: Record<string, string>) => NextResponse.redirect(new URL(`/settings/profile?${new URLSearchParams(query)}#calendar`, request.url));
  if (provider !== "google" && provider !== "microsoft") return back({ calendar_error: "Unknown calendar." });
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (request.nextUrl.searchParams.get("error") || !code || !state) {
    return back({ calendar_error: request.nextUrl.searchParams.get("error") === "access_denied" ? "You cancelled, so no calendar was connected." : "The calendar sign-in didn't finish. Try again." });
  }
  try {
    await apiFetch(`/me/calendar-sync/${provider}/callback`, { method: "POST", body: { code, state } });
    return back({ calendar: "connected" });
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) return NextResponse.redirect(new URL("/login", request.url));
    return back({ calendar_error: error instanceof ApiError ? error.message : "The calendar sign-in didn't finish. Try again." });
  }
}
