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
    title: "Fetch Channel Messages",
    description: "Fetch Discord messages from a channel",
    requires_target: false,
    required_auth_fields: ["bot_token"],
  },
  {
    id: "post_message",
    direction: "action",
    title: "Post Message",
    description: "Post a message to a channel",
    requires_target: true,
    required_auth_fields: ["bot_token"],
  },
  {
    id: "reply_message",
    direction: "action",
    title: "Reply Message",
    description: "Reply to an existing Discord message",
    requires_target: true,
    required_auth_fields: ["bot_token"],
  },
];

function buildFetchPayload(input: Record<string, unknown>): Record<string, unknown> {
  const channel_id = typeof input.channel_id === "string" ? input.channel_id : "";
  if (!channel_id) {
    throw new Error("Discord fetch requires query.channel_id");
  }
  return {
    channel_id,
    before: typeof input.before === "string" ? input.before : undefined,
    max_items: Math.min(1000, Math.max(1, Number(input.max_items || 50) || 50)),
  };
}

async function fetchItems(
  payload: Record<string, unknown>,
  context: ProviderCallContext,
): Promise<FetchedInboundItem[]> {
  const botToken = context.auth?.bot_token;
  if (!botToken) {
    throw new Error("Discord fetch requires auth.bot_token");
  }
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id : "";
  if (!channelId) {
    throw new Error("Discord fetch requires query.channel_id");
  }
  const maxItems = Math.min(1000, Math.max(1, Number(payload.max_items || 50) || 50));

  const items: FetchedInboundItem[] = [];
  let before =
    typeof payload.before === "string" && payload.before ? payload.before : undefined;

  while (items.length < maxItems) {
    const pageSize = Math.min(100, maxItems - items.length);
    const url = new URL(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    );
    url.searchParams.set("limit", String(pageSize));
    if (before) url.searchParams.set("before", before);

    const res = await fetch(url, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) {
      throw new Error(`Discord fetch failed (${res.status})`);
    }

    const messages = (await res.json()) as Array<{
      id: string;
      content?: string;
      author?: { id?: string };
      channel_id?: string;
      guild_id?: string;
    }>;
    if (messages.length === 0) break;

    items.push(
      ...messages.map((message) => ({
        event_id: message.id,
        event_type: "message.received",
        workspace_id: message.guild_id,
        channel_id: message.channel_id || channelId,
        user_id: message.author?.id,
        message_id: message.id,
        text: message.content || "",
      })),
    );

    before = messages[messages.length - 1]?.id;
    if (!before || messages.length < pageSize) break;
  }

  return items.slice(0, maxItems);
}

export const discordAdapter: ConnectorProviderAdapter = {
  provider: "discord",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (args.capability_id === "fetch.items") {
      return buildFetchPayload(args.input);
    }
    if (args.capability_id === "post_message") {
      return {
        text: typeof args.input.text === "string" ? args.input.text : "",
      };
    }
    if (args.capability_id === "reply_message") {
      return {
        message_id:
          typeof args.input.message_id === "string" ? args.input.message_id : "",
        text: typeof args.input.text === "string" ? args.input.text : "",
      };
    }
    throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"discord\"`);
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
    if (capability_id === "post_message" || capability_id === "reply_message") {
      return {
        kind: "action",
        result: makeActionResult("discord", capability_id, {
          target: context.target,
          text: typeof payload.text === "string" ? payload.text : null,
          message_id:
            typeof payload.message_id === "string" ? payload.message_id : null,
        }),
      };
    }
    throw new Error(`Unsupported capability \"${capability_id}\" for provider \"discord\"`);
  },
};
