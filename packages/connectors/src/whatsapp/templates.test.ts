import { expect, it } from "vitest";
import { listWhatsAppTemplates } from "./templates";
it("pages templates only on Meta's Graph origin and keeps tokens out of URLs", async () => {
  const calls: string[] = [];
  const items = await listWhatsAppTemplates(
    "123",
    "secret",
    async (url, init) => {
      calls.push(url);
      expect(url).not.toContain("secret");
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer secret",
      );
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? {
                data: [{ id: "a", name: "first" }],
                paging: {
                  next: "https://untrusted.example/steal",
                  cursors: { after: "page2" },
                },
              }
            : { data: [{ id: "b", name: "second" }] },
        ),
      );
    },
  );
  expect(items.map((t) => t.id)).toEqual(["a", "b"]);
  expect(calls[1]).toMatch(/^https:\/\/graph.facebook.com\//);
  expect(calls[1]).toContain("after=page2");
});
it("refuses incomplete pagination rather than disabling missing templates", async () => {
  await expect(
    listWhatsAppTemplates(
      "123",
      "secret",
      async () =>
        new Response(
          JSON.stringify({
            data: [],
            paging: { next: "next", cursors: { after: "same" } },
          }),
        ),
    ),
  ).rejects.toThrow("incomplete");
});
