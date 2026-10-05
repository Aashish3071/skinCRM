import { graphRequest, type FetchLike } from "../graph";
import { ConnectorError } from "../types";

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: { type: string; text?: string; format?: string }[];
}
export async function listWhatsAppTemplates(
  wabaId: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<WhatsAppTemplate[]> {
  const items: WhatsAppTemplate[] = [];
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({
      fields: "id,name,language,status,category,components",
      limit: "100",
      ...(after ? { after } : {}),
    });
    const response = await graphRequest<{
      data: WhatsAppTemplate[];
      paging?: { next?: string; cursors?: { after?: string } };
    }>(
      fetchImpl,
      `${encodeURIComponent(wabaId)}/message_templates?${q}`,
      token,
    );
    if (!Array.isArray(response.data))
      throw new ConnectorError("Meta returned an invalid template list", {
        retryable: true,
      });
    items.push(...response.data);
    if (!response.paging?.next) return items;
    after = response.paging.cursors?.after;
    if (!after || seen.has(after)) break;
    seen.add(after);
  }
  throw new ConnectorError(
    "Template catalogue is incomplete. Try again or contact support.",
    { retryable: false },
  );
}
