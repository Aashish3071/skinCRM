import { apiRaw } from "@/lib/api";

/** The clinic's logo for its public booking page, proxied like every other API read. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const upstream = await apiRaw(`/public/booking/${encodeURIComponent(slug)}/logo`);
  if (!upstream.ok) return new Response(null, { status: 404 });
  return new Response(upstream.body, {
    headers: { "content-type": upstream.headers.get("content-type") ?? "image/png", "cache-control": "public, max-age=300" },
  });
}
