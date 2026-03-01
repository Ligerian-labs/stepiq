import type { ConnectorProvider } from "@stepiq/core";

export interface InboundFetchRequest {
  provider: ConnectorProvider;
  query?: Record<string, unknown>;
  auth?: {
    access_token?: string;
    bot_token?: string;
  };
}

export interface FetchedInboundItem {
  event_id: string;
  event_type: string;
  workspace_id?: string;
  channel_id?: string;
  user_id?: string;
  message_id?: string;
  text?: string;
  entities?: Record<string, unknown>;
}

function toUnixSeconds(iso: string): number {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  return Math.floor(timestamp / 1000);
}

async function fetchGmailItems(
  req: InboundFetchRequest,
): Promise<FetchedInboundItem[]> {
  const accessToken = req.auth?.access_token;
  if (!accessToken) {
    throw new Error("Gmail fetch requires auth.access_token");
  }

  const maxItems = Math.min(
    1000,
    Math.max(1, Number(req.query?.max_items || 25) || 25),
  );
  const since =
    typeof req.query?.since === "string"
      ? toUnixSeconds(req.query.since)
      : null;
  const until =
    typeof req.query?.until === "string"
      ? toUnixSeconds(req.query.until)
      : null;
  const queryParts = ["in:inbox"];
  if (since) queryParts.push(`after:${since}`);
  if (until) queryParts.push(`before:${until}`);
  if (
    typeof req.query?.gmail_query === "string" &&
    req.query.gmail_query.trim()
  ) {
    queryParts.push(req.query.gmail_query.trim());
  }
  const q = queryParts.join(" ");

  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < maxItems) {
    const pageSize = Math.min(100, maxItems - ids.length);
    const listUrl = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
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
    const detailsUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,
    );
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
      entities: {
        from,
        subject,
        date,
      },
    });
  }

  return items;
}

async function fetchDiscordItems(
  req: InboundFetchRequest,
): Promise<FetchedInboundItem[]> {
  const botToken = req.auth?.bot_token;
  if (!botToken) {
    throw new Error("Discord fetch requires auth.bot_token");
  }
  const channelId =
    typeof req.query?.channel_id === "string" ? req.query.channel_id : "";
  if (!channelId) {
    throw new Error("Discord fetch requires query.channel_id");
  }
  const maxItems = Math.min(
    1000,
    Math.max(1, Number(req.query?.max_items || 50) || 50),
  );

  const items: FetchedInboundItem[] = [];
  let before =
    typeof req.query?.before === "string" && req.query.before
      ? req.query.before
      : undefined;
  while (items.length < maxItems) {
    const pageSize = Math.min(100, maxItems - items.length);
    const url = new URL(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    );
    url.searchParams.set("limit", String(pageSize));
    if (before) {
      url.searchParams.set("before", before);
    }

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

async function fetchGithubItems(
  req: InboundFetchRequest,
): Promise<FetchedInboundItem[]> {
  const accessToken = req.auth?.access_token;
  if (!accessToken) {
    throw new Error("GitHub fetch requires auth.access_token");
  }

  const owner =
    typeof req.query?.repo_owner === "string" ? req.query.repo_owner.trim() : "";
  const repo =
    typeof req.query?.repo_name === "string" ? req.query.repo_name.trim() : "";
  if (!owner || !repo) {
    throw new Error("GitHub fetch requires query.repo_owner and query.repo_name");
  }

  const resourceType =
    typeof req.query?.type === "string" ? req.query.type : "issues";
  if (resourceType !== "issues" && resourceType !== "pulls") {
    throw new Error('GitHub fetch query.type must be "issues" or "pulls"');
  }

  const maxItems = Math.min(
    1000,
    Math.max(1, Number(req.query?.max_items || 50) || 50),
  );
  const state =
    typeof req.query?.state === "string" && req.query.state.trim()
      ? req.query.state.trim()
      : "open";
  const since =
    typeof req.query?.since === "string" && req.query.since.trim()
      ? req.query.since.trim()
      : undefined;

  const items: FetchedInboundItem[] = [];
  let page = 1;
  while (items.length < maxItems) {
    const pageSize = Math.min(100, maxItems - items.length);
    const url = new URL(
      resourceType === "pulls"
        ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`
        : `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    );
    url.searchParams.set("per_page", String(pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("state", state);
    if (since) {
      url.searchParams.set("since", since);
    }
    if (resourceType === "issues") {
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "desc");
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub fetch failed (${res.status})`);
    }

    const records = (await res.json()) as Array<{
      id: number;
      number: number;
      title?: string;
      body?: string;
      html_url?: string;
      updated_at?: string;
      user?: { id?: number; login?: string };
      pull_request?: Record<string, unknown>;
    }>;
    if (records.length === 0) break;

    for (const record of records) {
      if (items.length >= maxItems) break;
      if (resourceType === "issues" && record.pull_request) continue;
      items.push({
        event_id: String(record.id),
        event_type:
          resourceType === "pulls" ? "pull_request.updated" : "issue.updated",
        workspace_id: `${owner}/${repo}`,
        user_id: record.user?.id ? String(record.user.id) : undefined,
        message_id: String(record.number),
        text: `${record.title || ""}\n\n${record.body || ""}`.trim(),
        entities: {
          repo_owner: owner,
          repo_name: repo,
          type: resourceType,
          number: record.number,
          title: record.title || null,
          url: record.html_url || null,
          user_login: record.user?.login || null,
          updated_at: record.updated_at || null,
        },
      });
    }

    if (records.length < pageSize) break;
    page += 1;
  }

  return items;
}

export async function fetchFromSource(
  req: InboundFetchRequest,
): Promise<FetchedInboundItem[]> {
  if (req.provider === "gmail") return fetchGmailItems(req);
  if (req.provider === "discord") return fetchDiscordItems(req);
  if (req.provider === "github") return fetchGithubItems(req);
  throw new Error(
    `Pull fetch not implemented for provider "${req.provider}". Use push webhook ingestion for this provider.`,
  );
}
