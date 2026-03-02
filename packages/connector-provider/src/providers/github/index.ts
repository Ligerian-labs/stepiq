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
    title: "Fetch Issues or Pull Requests",
    description: "Fetch GitHub issues or pull requests from a repository",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
  {
    id: "create_issue",
    direction: "action",
    title: "Create Issue",
    description: "Create a GitHub issue",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
  {
    id: "comment_issue",
    direction: "action",
    title: "Comment Issue",
    description: "Comment on a GitHub issue",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
  {
    id: "create_pull_request",
    direction: "action",
    title: "Create Pull Request",
    description: "Create a GitHub pull request",
    requires_target: false,
    required_auth_fields: ["access_token"],
  },
];

function buildFetchPayload(input: Record<string, unknown>): Record<string, unknown> {
  const repo_owner =
    typeof input.repo_owner === "string" ? input.repo_owner.trim() : "";
  const repo_name = typeof input.repo_name === "string" ? input.repo_name.trim() : "";
  if (!repo_owner || !repo_name) {
    throw new Error("GitHub fetch requires query.repo_owner and query.repo_name");
  }

  const type = typeof input.type === "string" ? input.type : "issues";
  if (type !== "issues" && type !== "pulls") {
    throw new Error('GitHub fetch query.type must be "issues" or "pulls"');
  }

  return {
    repo_owner,
    repo_name,
    type,
    state:
      typeof input.state === "string" && input.state.trim()
        ? input.state.trim()
        : "open",
    since: typeof input.since === "string" ? input.since : undefined,
    max_items: Math.min(1000, Math.max(1, Number(input.max_items || 50) || 50)),
  };
}

async function fetchItems(
  payload: Record<string, unknown>,
  context: ProviderCallContext,
): Promise<FetchedInboundItem[]> {
  const accessToken = context.auth?.access_token;
  if (!accessToken) {
    throw new Error("GitHub fetch requires auth.access_token");
  }

  const owner = typeof payload.repo_owner === "string" ? payload.repo_owner.trim() : "";
  const repo = typeof payload.repo_name === "string" ? payload.repo_name.trim() : "";
  if (!owner || !repo) {
    throw new Error("GitHub fetch requires query.repo_owner and query.repo_name");
  }

  const resourceType = typeof payload.type === "string" ? payload.type : "issues";
  if (resourceType !== "issues" && resourceType !== "pulls") {
    throw new Error('GitHub fetch query.type must be "issues" or "pulls"');
  }

  const maxItems = Math.min(1000, Math.max(1, Number(payload.max_items || 50) || 50));
  const state =
    typeof payload.state === "string" && payload.state.trim()
      ? payload.state.trim()
      : "open";
  const since =
    typeof payload.since === "string" && payload.since.trim()
      ? payload.since.trim()
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
    if (since) url.searchParams.set("since", since);
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

export const githubAdapter: ConnectorProviderAdapter = {
  provider: "github",
  getCapabilities() {
    return capabilities;
  },
  buildPayload(args: BuildPayloadArgs) {
    if (args.capability_id === "fetch.items") {
      return buildFetchPayload(args.input);
    }
    if (
      args.capability_id === "create_issue" ||
      args.capability_id === "comment_issue" ||
      args.capability_id === "create_pull_request"
    ) {
      return { ...args.input };
    }
    throw new Error(`Unsupported capability \"${args.capability_id}\" for provider \"github\"`);
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
    if (
      capability_id === "create_issue" ||
      capability_id === "comment_issue" ||
      capability_id === "create_pull_request"
    ) {
      return {
        kind: "action",
        result: makeActionResult("github", capability_id, {
          repo:
            typeof payload.repo === "string"
              ? payload.repo
              : typeof context.target === "string"
                ? context.target
                : null,
          issue_number:
            typeof payload.issue_number === "number" ? payload.issue_number : null,
          title: typeof payload.title === "string" ? payload.title : null,
        }),
      };
    }
    throw new Error(`Unsupported capability \"${capability_id}\" for provider \"github\"`);
  },
};
