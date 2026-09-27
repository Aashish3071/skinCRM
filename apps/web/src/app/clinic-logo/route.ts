import { apiRaw } from "@/lib/api";

/** The clinic's logo, fetched server-side with the session cookie. */
export async function GET() {
  const upstream = await apiRaw("/clinic/logo");
  if (!upstream.ok) return new Response(null, { status: 404 });
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/png",
      "cache-control": upstream.headers.get("cache-control") ?? "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
