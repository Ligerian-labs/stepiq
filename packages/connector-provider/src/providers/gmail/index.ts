import type {
  BuildPayloadArgs,
  ConnectorProviderAdapter,
  FetchedInboundItem,
  ProviderCallContext,
  ProviderCapability,
} from "../../contracts.js";
import { makeActionResult } from "../shared/action-result.js";

const capabilities: ProviderCapability[] = [
  {
    id: "fetch.items",
    direction: "fetch",
    title: "Fetch Inbox Messages",
    description: "Fetch Gmail messages from Inbox with optional time range",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
  {
    id: "label_message",
    direction: "action",
    title: "Label Message",
    description: "Apply labels to an existing Gmail message",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
  {
    id: "archive_message",
    direction: "action",
    title: "Archive Message",
    description: "Archive an existing Gmail message",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
];

function toUnixSeconds(iso: string): number {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return Math.floor(timestamp / 1000);
}

function buildFetchPayload(input: Record<string, unknown>): Record<string, unknown> {
  const max_items = Math.min(1000, Math.max(1, Number(input.max_items || 25) || 25));
  return {
    max_items,
    since: typeof input.since === "string" ? input.since : undefined,
    until: typeof input.until === "string" ? input.until : undefined,
    gmail_query: typeof input.gmail_query === "string" ? input.gmail_query : undefined,
  };
}

async function fetchItems(
  payload: Record<string, unknown>,
  context: ProviderCallContext,
): Promise<FetchedInboundItem[]> {
  const accessToken = context.auth?.access_token;
  if (!accessToken) {
    throw new Error("Gmail fetch requires auth.access_token");
  }

  const maxItems = Math.min(
    1000,
    Math.max(1, Number(payload.max_items || 25) || 25),
  );
  const since = typeof payload.since === "string" ? toUnixSeconds(payload.since) : null;
  const until = typeof payload.until === "string" ? toUnixSeconds(payload.until) : null;
  const queryParts = ["in:inbox"];
  if (since) queryParts.push(`after:${since}`);
  if (until) queryParts.push(`before:${until}`);
  if (typeof payload.gmail_query === "string" && payload.gmail_query.trim()) {
    queryParts.push(payload.gmail_query.trim());
  }
  const q = queryParts.join(" ");

  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < maxItems) {
    const pageSize = Math.min(100, maxItems - ids.length);
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(pageSize));
    listUrl.searchParams.set("q", q);
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      throw new Error(`Gmail list failed (${listRes.status})`);
    }

    const listBody = (await listRes.json()) as {
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    };
    const pageIds = (listBody.messages || []).map((message) => message.id);
    ids.push(...pageIds);
    pageToken = listBody.nextPageToken;
    if (!pageToken || pageIds.length === 0) break;
  }

  const items: FetchedInboundItem[] = [];
  for (const id of ids) {
    if (items.length >= maxItems) break;
    const detailsUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    detailsUrl.searchParams.set("format", "metadata");
    detailsUrl.searchParams.set("metadataHeaders", "From");
    detailsUrl.searchParams.set("metadataHeaders", "Subject");
    detailsUrl.searchParams.set("metadataHeaders", "Date");

    const detailsRes = await fetch(detailsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!detailsRes.ok) continue;

    const details = (await detailsRes.json()) as {
      id?: string;
      snippet?: string;
      payload?: {
        headers?: Array<{ name?: string; value?: string }>;
      };
    };
    const headers = details.payload?.headers || [];
    const from = headers.find((header) => header.name === "From")?.value;
    const subject = headers.find((header) => header.name === "Subject")?.value;
    const date = headers.find((header) => header.name === "Date")?.value;

    items.push({
      event_id: details.id || id,
      event_type: "message.received",
      message_id: details.id || id,
      text: details.snippet || "",
      entities: { from, subject, date },
    });
  }

  return items;
}

export const gmailAdapter: ConnectorProviderAdapter = {
  provider: "gmail",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (args.capability_id === "fetch.items") {
      return buildFetchPayload(args.input);
    }
    if (args.capability_id === "label_message") {
      return {
        message_id:
          typeof args.input.message_id === "string" ? args.input.message_id : "",
        add_label_ids: Array.isArray(args.input.add_label_ids)
          ? args.input.add_label_ids
          : [],
      };
    }
    if (args.capability_id === "archive_message") {
      return {
        message_id:
          typeof args.input.message_id === "string" ? args.input.message_id : "",
      };
    }
    throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"gmail\"`);
  },
  async callTool(
    capability_id: string,
    payload: Record<string, unknown>,
    context: ProviderCallContext,
  ) {
    if (capability_id === "fetch.items") {
      return {
        kind: "fetch",
        items: await fetchItems(payload, context),
      };
    }
    if (capability_id === "label_message" || capability_id === "archive_message") {
      return {
        kind: "action",
        result: makeActionResult("gmail", capability_id, {
          message_id: typeof payload.message_id === "string" ? payload.message_id : null,
          add_label_ids: Array.isArray(payload.add_label_ids)
            ? payload.add_label_ids
            : undefined,
        }),
      };
    }
    throw new Error(`Unsupported capability \"${capability_id}\" for provider \"gmail\"`);
  },
};
