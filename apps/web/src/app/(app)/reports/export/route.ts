import { apiRaw } from "@/lib/api";

/** Streams the CSV from the API, keeping the session cookie server-side. */
export async function GET(request: Request) {
  const search = new URL(request.url).search;
  const upstream = await apiRaw(`/reports/export${search}`);
  if (!upstream.ok) {
    return new Response("You don't have access to export, or the dates are invalid.", { status: upstream.status });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/csv",
      "content-disposition": upstream.headers.get("content-disposition") ?? 'attachment; filename="leads.csv"',
      "cache-control": "no-store",
    },
  });
}
