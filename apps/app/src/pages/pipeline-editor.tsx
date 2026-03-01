import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import YAML from "yaml";
import { AppShell } from "../components/app-shell";
import {
  trackPipelineDeleted,
  trackPipelineRunTriggered,
  trackPipelineSaved,
  trackSecretCreated,
  trackSecretDeleted,
  trackSecretUpdated,
} from "../lib/analytics";
import {
  ApiError,
  type PipelineRecord,
  type RunRecord,
  type SecretRecord,
  type UserMe,
  apiFetch,
} from "../lib/api";

interface StepDef {
  id: string;
  name: string;
  type: string;
  model: string;
  prompt: string;
  outputFormat?: string;
  timeout?: number;
  retries?: number;
  connector?: {
    mode: "fetch" | "action";
    provider: string;
    authSecretName: string;
    query: string;
    action: string;
    target: string;
    payload: string;
    idempotencyKey: string;
    privacyMode: "strict" | "balanced";
    maxItems?: number;
    dryRun?: boolean;
  };
}

type ConnectorStepState = NonNullable<StepDef["connector"]>;

type ConnectorFetchPreset = {
  id: string;
  label: string;
  build: () => Record<string, unknown>;
};

type ConnectorActionPreset = {
  id: string;
  label: string;
  action: string;
  target?: string;
  buildPayload: () => Record<string, unknown>;
};

interface DefinitionStep {
  id?: string;
  name?: string;
  type?: string;
  model?: string;
  prompt?: string;
  outputFormat?: string;
  output_format?: string;
  timeout?: number;
  timeout_seconds?: number;
  retries?: number;
  retry?: {
    max_attempts?: number;
    backoff_ms?: number;
  };
  connector?: {
    mode?: "fetch" | "action";
    provider?: string;
    auth_secret_name?: string;
    query?: Record<string, unknown>;
    action?: string;
    target?: string;
    payload?: Record<string, unknown>;
    idempotency_key?: string;
    privacy_mode?: "strict" | "balanced";
    max_items?: number;
    dry_run?: boolean;
  };
}

interface DefinitionOutput {
  from?: string;
  deliver?: Array<{
    type?: string;
    url?: string;
    method?: string;
    signing_secret_name?: string;
  }>;
}

interface OutboundWebhookConfig {
  enabled: boolean;
  from: string;
  url: string;
  method: "POST" | "PUT" | "GET";
  signingSecretName: string;
}

interface ModelOption {
  id: string;
  name: string;
}

function getPromptTemplateWarning(
  prompt: string,
  stepIds: string[],
): string | null {
  const openCount = (prompt.match(/\{\{/g) || []).length;
  const closeCount = (prompt.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) {
    return "Unbalanced Handlebars braces. Check {{ and }}.";
  }

  const refs = [
    ...prompt.matchAll(/\{\{\s*steps\.([a-zA-Z0-9_]+)\.output\s*\}\}/g),
  ];
  for (const ref of refs) {
    const key = ref[1] || "";
    if (!key) continue;
    const isNumeric = /^\d+$/.test(key);
    if (!isNumeric && !stepIds.includes(key)) {
      return `Unknown step reference "${key}". Use an existing step id or a numeric alias.`;
    }
  }

  return null;
}

function newStep(index: number): StepDef {
  return {
    id: `step_${index}`,
    name: `Step ${index}`,
    type: "llm",
    model: "gpt-5.2",
    prompt: "",
    outputFormat: "text",
    timeout: 30,
    retries: 2,
  };
}

function defaultConnectorConfig(): ConnectorStepState {
  return {
    mode: "fetch",
    provider: "gmail",
    authSecretName: "",
    query: JSON.stringify({}, null, 2),
    action: "",
    target: "",
    payload: JSON.stringify({}, null, 2),
    idempotencyKey: "",
    privacyMode: "strict",
    maxItems: 25,
    dryRun: false,
  };
}

function toUtcIso(date: Date): string {
  return date.toISOString().replace(".000", "");
}

function utcDayRange(offsetDays: number): { since: string; until: string } {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() + offsetDays);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { since: toUtcIso(start), until: toUtcIso(end) };
}

function connectorDefaultSecretName(provider: string): string {
  if (provider === "gmail") return "GMAIL_ACCESS_TOKEN";
  if (provider === "github") return "GITHUB_TOKEN";
  if (provider === "discord") return "DISCORD_BOT_TOKEN";
  if (provider === "slack") return "SLACK_BOT_TOKEN";
  if (provider === "telegram") return "TELEGRAM_BOT_TOKEN";
  if (provider === "jira") return "JIRA_API_TOKEN";
  if (provider === "linear") return "LINEAR_API_KEY";
  if (provider === "monday") return "MONDAY_API_TOKEN";
  if (provider === "s3") return "S3_ACCESS_KEY";
  return "";
}

function connectorFetchPresets(provider: string): ConnectorFetchPreset[] {
  if (provider === "gmail") {
    return [
      {
        id: "gmail_yesterday",
        label: "Yesterday Inbox",
        build: () => {
          const range = utcDayRange(-1);
          return {
            since: range.since,
            until: range.until,
            max_items: 50,
          };
        },
      },
      {
        id: "gmail_today_unread",
        label: "Today Unread",
        build: () => {
          const range = utcDayRange(0);
          return {
            since: range.since,
            until: range.until,
            gmail_query: "is:unread",
            max_items: 50,
          };
        },
      },
      {
        id: "gmail_last7",
        label: "Last 7 Days",
        build: () => {
          const now = new Date();
          const since = new Date(now);
          since.setUTCDate(since.getUTCDate() - 7);
          return {
            since: toUtcIso(since),
            until: toUtcIso(now),
            max_items: 200,
          };
        },
      },
    ];
  }
  if (provider === "discord") {
    return [
      {
        id: "discord_latest_100",
        label: "Latest 100 (Channel)",
        build: () => ({
          channel_id: "",
          max_items: 100,
        }),
      },
      {
        id: "discord_latest_500",
        label: "Latest 500 (Channel)",
        build: () => ({
          channel_id: "",
          max_items: 500,
        }),
      },
      {
        id: "discord_before_cursor",
        label: "Before Cursor",
        build: () => ({
          channel_id: "",
          before: "",
          max_items: 100,
        }),
      },
    ];
  }
  if (provider === "slack") {
    return [
      {
        id: "slack_latest_channel_messages",
        label: "Channel Messages",
        build: () => ({
          channel_id: "",
          max_items: 100,
        }),
      },
      {
        id: "slack_thread_replies",
        label: "Thread Replies",
        build: () => ({
          channel_id: "",
          thread_ts: "",
          max_items: 100,
        }),
      },
    ];
  }
  if (provider === "telegram") {
    return [
      {
        id: "telegram_recent_updates",
        label: "Recent Updates",
        build: () => ({
          offset: 0,
          limit: 100,
          timeout: 0,
        }),
      },
      {
        id: "telegram_chat_messages",
        label: "Specific Chat",
        build: () => ({
          chat_id: "",
          max_items: 100,
        }),
      },
    ];
  }
  if (provider === "linear") {
    return [
      {
        id: "linear_updated_issues",
        label: "Updated Issues",
        build: () => ({
          team_id: "",
          updated_since: toUtcIso(new Date(Date.now() - 24 * 60 * 60 * 1000)),
          limit: 100,
        }),
      },
      {
        id: "linear_open_issues",
        label: "Open Issues",
        build: () => ({
          team_id: "",
          state: "unstarted",
          limit: 100,
        }),
      },
    ];
  }
  if (provider === "jira") {
    return [
      {
        id: "jira_recent_updated",
        label: "Recently Updated",
        build: () => ({
          project_key: "",
          jql: "updated >= -1d ORDER BY updated DESC",
          max_results: 100,
        }),
      },
      {
        id: "jira_open_bugs",
        label: "Open Bugs",
        build: () => ({
          project_key: "",
          jql: "issuetype = Bug AND statusCategory != Done ORDER BY priority DESC",
          max_results: 100,
        }),
      },
    ];
  }
  if (provider === "monday") {
    return [
      {
        id: "monday_recent_items",
        label: "Recent Items",
        build: () => ({
          board_id: "",
          updated_since: toUtcIso(
            new Date(Date.now() - 24 * 60 * 60 * 1000),
          ),
          limit: 100,
        }),
      },
      {
        id: "monday_group_items",
        label: "Group Items",
        build: () => ({
          board_id: "",
          group_id: "",
          limit: 100,
        }),
      },
    ];
  }
  if (provider === "s3") {
    return [
      {
        id: "s3_prefix_recent",
        label: "Prefix (Recent)",
        build: () => ({
          bucket: "",
          prefix: "",
          max_items: 200,
        }),
      },
      {
        id: "s3_modified_since",
        label: "Modified Since",
        build: () => ({
          bucket: "",
          prefix: "",
          modified_since: toUtcIso(
            new Date(Date.now() - 24 * 60 * 60 * 1000),
          ),
          max_items: 200,
        }),
      },
    ];
  }
  if (provider === "github") {
    return [
      {
        id: "github_recent_issues",
        label: "Recent Issues",
        build: () => ({
          repo_owner: "",
          repo_name: "",
          type: "issues",
          state: "open",
          max_items: 100,
        }),
      },
      {
        id: "github_recent_pulls",
        label: "Recent Pull Requests",
        build: () => ({
          repo_owner: "",
          repo_name: "",
          type: "pulls",
          state: "open",
          max_items: 100,
        }),
      },
      {
        id: "github_updated_since_24h",
        label: "Updated Last 24h",
        build: () => ({
          repo_owner: "",
          repo_name: "",
          type: "issues",
          state: "all",
          since: toUtcIso(new Date(Date.now() - 24 * 60 * 60 * 1000)),
          max_items: 100,
        }),
      },
    ];
  }
  return [];
}

function connectorActionPresets(provider: string): ConnectorActionPreset[] {
  if (provider === "slack") {
    return [
      {
        id: "slack_post_message",
        label: "Post Message",
        action: "post_message",
        target: "",
        buildPayload: () => ({ text: "{{steps.step_1.output}}" }),
      },
      {
        id: "slack_reply_thread",
        label: "Reply Thread",
        action: "reply_thread",
        target: "",
        buildPayload: () => ({ thread_ts: "", text: "{{steps.step_1.output}}" }),
      },
      {
        id: "slack_upload_file",
        label: "Upload File",
        action: "upload_file",
        target: "",
        buildPayload: () => ({
          filename: "report.txt",
          content: "{{steps.step_1.output}}",
        }),
      },
    ];
  }
  if (provider === "discord") {
    return [
      {
        id: "discord_post_message",
        label: "Post Message",
        action: "post_message",
        target: "",
        buildPayload: () => ({ text: "{{steps.step_1.output}}" }),
      },
      {
        id: "discord_reply",
        label: "Reply Message",
        action: "reply_message",
        target: "",
        buildPayload: () => ({ message_id: "", text: "{{steps.step_1.output}}" }),
      },
    ];
  }
  if (provider === "telegram") {
    return [
      {
        id: "telegram_send_message",
        label: "Send Message",
        action: "send_message",
        target: "",
        buildPayload: () => ({ text: "{{steps.step_1.output}}" }),
      },
      {
        id: "telegram_send_document",
        label: "Send Document",
        action: "send_document",
        target: "",
        buildPayload: () => ({ caption: "Pipeline output", file_url: "" }),
      },
    ];
  }
  if (provider === "linear") {
    return [
      {
        id: "linear_create_issue",
        label: "Create Issue",
        action: "create_issue",
        target: "",
        buildPayload: () => ({
          team_id: "",
          title: "Pipeline issue",
          description: "{{steps.step_1.output}}",
        }),
      },
      {
        id: "linear_comment_issue",
        label: "Comment Issue",
        action: "comment_issue",
        target: "",
        buildPayload: () => ({ issue_id: "", body: "{{steps.step_1.output}}" }),
      },
    ];
  }
  if (provider === "jira") {
    return [
      {
        id: "jira_create_issue",
        label: "Create Issue",
        action: "create_issue",
        target: "",
        buildPayload: () => ({
          project_key: "",
          issue_type: "Task",
          summary: "Pipeline issue",
          description: "{{steps.step_1.output}}",
        }),
      },
      {
        id: "jira_comment_issue",
        label: "Comment Issue",
        action: "comment_issue",
        target: "",
        buildPayload: () => ({ issue_key: "", body: "{{steps.step_1.output}}" }),
      },
    ];
  }
  if (provider === "monday") {
    return [
      {
        id: "monday_create_item",
        label: "Create Item",
        action: "create_item",
        target: "",
        buildPayload: () => ({
          board_id: "",
          item_name: "Pipeline item",
          column_values: { text: "{{steps.step_1.output}}" },
        }),
      },
      {
        id: "monday_add_update",
        label: "Add Update",
        action: "add_update",
        target: "",
        buildPayload: () => ({ item_id: "", body: "{{steps.step_1.output}}" }),
      },
    ];
  }
  if (provider === "s3") {
    return [
      {
        id: "s3_put_object",
        label: "Put Object",
        action: "put_object",
        target: "",
        buildPayload: () => ({
          bucket: "",
          key: "pipelines/output.txt",
          content: "{{steps.step_1.output}}",
        }),
      },
      {
        id: "s3_copy_object",
        label: "Copy Object",
        action: "copy_object",
        target: "",
        buildPayload: () => ({
          source_bucket: "",
          source_key: "",
          destination_bucket: "",
          destination_key: "",
        }),
      },
    ];
  }
  if (provider === "gmail") {
    return [
      {
        id: "gmail_label_message",
        label: "Label Message",
        action: "label_message",
        target: "",
        buildPayload: () => ({ message_id: "", add_label_ids: ["IMPORTANT"] }),
      },
      {
        id: "gmail_archive_message",
        label: "Archive Message",
        action: "archive_message",
        target: "",
        buildPayload: () => ({ message_id: "" }),
      },
    ];
  }
  if (provider === "github") {
    return [
      {
        id: "github_create_issue",
        label: "Create Issue",
        action: "create_issue",
        target: "",
        buildPayload: () => ({
          repo: "",
          title: "Pipeline generated issue",
          body: "{{steps.step_1.output}}",
          labels: ["automation"],
        }),
      },
      {
        id: "github_comment_issue",
        label: "Comment on Issue",
        action: "comment_issue",
        target: "",
        buildPayload: () => ({
          repo: "",
          issue_number: 1,
          body: "{{steps.step_1.output}}",
        }),
      },
      {
        id: "github_create_pr",
        label: "Create Pull Request",
        action: "create_pull_request",
        target: "",
        buildPayload: () => ({
          repo: "",
          title: "Automated PR",
          head: "automation/changes",
          base: "main",
          body: "{{steps.step_1.output}}",
        }),
      },
    ];
  }
  return [];
}

function normalizeOutboundWebhook(
  definition: unknown,
): OutboundWebhookConfig | null {
  if (!definition || typeof definition !== "object") return null;
  const output = (definition as { output?: DefinitionOutput }).output;
  if (!output || typeof output !== "object") return null;

  const delivery = (output.deliver || []).find((d) => d.type === "webhook");
  if (!delivery) return null;

  const method =
    delivery.method === "PUT" || delivery.method === "GET"
      ? delivery.method
      : "POST";

  return {
    enabled: true,
    from: output.from || "",
    url: delivery.url || "",
    method,
    signingSecretName: delivery.signing_secret_name || "",
  };
}

function areOutboundWebhookConfigsEqual(
  current: OutboundWebhookConfig,
  persisted: OutboundWebhookConfig | null,
): boolean {
  if (!persisted) return !current.enabled;
  if (!current.enabled) return false;
  return (
    current.from === persisted.from &&
    current.url.trim() === persisted.url.trim() &&
    current.method === persisted.method &&
    current.signingSecretName.trim() === persisted.signingSecretName.trim()
  );
}

function parseJsonSafe(input: string, fallback: Record<string, unknown> = {}) {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function canUseConnectorSteps(plan: string | undefined): boolean {
  const normalized = (plan || "").toLowerCase();
  return normalized === "pro" || normalized === "enterprise";
}

export function PipelineEditorPage() {
  const { pipelineId } = useParams({ strict: false }) as { pipelineId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pipelineQ = useQuery({
    queryKey: ["pipeline", pipelineId],
    queryFn: () => apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`),
    enabled: Boolean(pipelineId),
  });

  const modelsQ = useQuery({
    queryKey: ["models"],
    queryFn: () => apiFetch<ModelOption[]>("/api/models", undefined, false),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDef[]>([]);
  const [outputFromStepId, setOutputFromStepId] = useState("");
  const [outputWebhookEnabled, setOutputWebhookEnabled] = useState(false);
  const [outputWebhookUrl, setOutputWebhookUrl] = useState("");
  const [outputWebhookMethod, setOutputWebhookMethod] = useState<
    "POST" | "PUT" | "GET"
  >("POST");
  const [outputWebhookSigningSecret, setOutputWebhookSigningSecret] =
    useState("");
  const [variables, setVariables] = useState<{ key: string; value: string }[]>(
    [],
  );
  const [expandedStep, setExpandedStep] = useState<number>(0);
  const [message, setMessage] = useState<string | null>(null);
  const [pipelineSecretName, setPipelineSecretName] = useState("");
  const [pipelineSecretValue, setPipelineSecretValue] = useState("");
  const [pipelineSecretUpdateName, setPipelineSecretUpdateName] = useState<
    string | null
  >(null);
  const [pipelineSecretUpdateValue, setPipelineSecretUpdateValue] =
    useState("");
  const [pipelineSecretError, setPipelineSecretError] = useState<string | null>(
    null,
  );
  const [pipelineSecretSuccess, setPipelineSecretSuccess] = useState<
    string | null
  >(null);
  const [yamlMode, setYamlMode] = useState(false);
  const [rawYaml, setRawYaml] = useState("");
  const [selectedPrevStepToken, setSelectedPrevStepToken] = useState<
    Record<number, string>
  >({});
  const [selectedConnectorPreset, setSelectedConnectorPreset] = useState<
    Record<number, string>
  >({});
  const [selectedConnectorActionPreset, setSelectedConnectorActionPreset] =
    useState<Record<number, string>>({});
  const promptRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});

  const modelOptions = (() => {
    const fromApi = (modelsQ.data ?? []).map((model) => ({
      id: model.id,
      label: `${model.name} (${model.id})`,
    }));
    const fromSteps = steps
      .map((step) => step.model)
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
    const merged = [...fromApi, ...fromSteps];
    return merged.filter(
      (item, index) => merged.findIndex((x) => x.id === item.id) === index,
    );
  })();

  const pipelineSecretsQ = useQuery({
    queryKey: ["pipeline-secrets", pipelineId],
    queryFn: () =>
      apiFetch<SecretRecord[]>(`/api/pipelines/${pipelineId}/secrets`),
    enabled: Boolean(pipelineId),
  });
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<UserMe>("/api/user/me"),
  });
  const connectorStepsEnabled = canUseConnectorSteps(meQ.data?.plan);

  // Load pipeline data
  useEffect(() => {
    if (!pipelineQ.data) return;
    const p = pipelineQ.data;
    setName(p.name);
    setDescription(p.description || "");
    const def = (p.definition ?? {}) as {
      steps?: DefinitionStep[];
      variables?: Record<string, string>;
      output?: DefinitionOutput;
    };
    setSteps(
      (def.steps ?? []).map((s, i) => ({
        id: s.id || `step_${i + 1}`,
        name: s.name || `Step ${i + 1}`,
        type: s.type || "llm",
        model: s.model || "gpt-5.2",
        prompt: s.prompt || "",
        outputFormat: s.output_format || s.outputFormat || "text",
        timeout: s.timeout_seconds ?? s.timeout ?? 30,
        retries: s.retry?.max_attempts ?? s.retries ?? 2,
        connector:
          s.type === "connector"
            ? {
                mode: s.connector?.mode || "fetch",
                provider: s.connector?.provider || "gmail",
                authSecretName: s.connector?.auth_secret_name || "",
                query: JSON.stringify(s.connector?.query || {}, null, 2),
                action: s.connector?.action || "",
                target: s.connector?.target || "",
                payload: JSON.stringify(s.connector?.payload || {}, null, 2),
                idempotencyKey: s.connector?.idempotency_key || "",
                privacyMode: s.connector?.privacy_mode || "strict",
                maxItems: s.connector?.max_items ?? 25,
                dryRun: s.connector?.dry_run ?? false,
              }
            : undefined,
      })),
    );
    const vars = def.variables ?? {};
    setVariables(
      Object.entries(vars).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    );
    const fallbackFrom =
      (def.steps ?? []).at((def.steps ?? []).length - 1)?.id || "";
    const from = def.output?.from || fallbackFrom;
    const outboundWebhook = (def.output?.deliver || []).find(
      (d) => d.type === "webhook",
    );
    setOutputFromStepId(from);
    setOutputWebhookEnabled(Boolean(outboundWebhook));
    setOutputWebhookUrl(outboundWebhook?.url || "");
    setOutputWebhookMethod(
      outboundWebhook?.method === "PUT" || outboundWebhook?.method === "GET"
        ? outboundWebhook.method
        : "POST",
    );
    setOutputWebhookSigningSecret(outboundWebhook?.signing_secret_name || "");
    setRawYaml(YAML.stringify(p.definition ?? {}));
  }, [pipelineQ.data]);

  // Build definition from structured state
  const buildDefinition = useCallback(() => {
    if (yamlMode) {
      try {
        return YAML.parse(rawYaml);
      } catch {
        return {};
      }
    }
    const vars: Record<string, string> = {};
    for (const v of variables) {
      if (v.key) vars[v.key] = v.value;
    }
    return {
      name,
      version: pipelineQ.data?.version ?? 1,
      steps: steps.map((s) => {
        if (s.type === "connector") {
          const connector = s.connector || defaultConnectorConfig();
          return {
            id: s.id,
            name: s.name,
            type: "connector",
            timeout_seconds: s.timeout,
            retry: {
              max_attempts: s.retries ?? 1,
              backoff_ms: 1000,
            },
            connector: {
              mode: connector.mode,
              provider: connector.provider,
              auth_secret_name: connector.authSecretName || undefined,
              query: parseJsonSafe(connector.query),
              action:
                connector.mode === "action"
                  ? connector.action || undefined
                  : undefined,
              target:
                connector.mode === "action"
                  ? connector.target || undefined
                  : undefined,
              payload:
                connector.mode === "action"
                  ? parseJsonSafe(connector.payload)
                  : undefined,
              idempotency_key:
                connector.mode === "action"
                  ? connector.idempotencyKey || undefined
                  : undefined,
              privacy_mode: connector.privacyMode,
              max_items: connector.maxItems,
              dry_run: connector.dryRun || false,
            },
          };
        }
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          model: s.model,
          prompt: s.prompt,
          output_format: s.outputFormat,
          timeout_seconds: s.timeout,
          retry: {
            max_attempts: s.retries ?? 1,
            backoff_ms: 1000,
          },
        };
      }),
      variables: Object.keys(vars).length > 0 ? vars : undefined,
      output: {
        from: outputFromStepId || steps[steps.length - 1]?.id || "",
        deliver: outputWebhookEnabled
          ? [
              {
                type: "webhook",
                url: outputWebhookUrl,
                method: outputWebhookMethod,
                signing_secret_name: outputWebhookSigningSecret || undefined,
              },
            ]
          : undefined,
      },
    };
  }, [
    yamlMode,
    rawYaml,
    name,
    steps,
    variables,
    outputFromStepId,
    outputWebhookEnabled,
    outputWebhookUrl,
    outputWebhookMethod,
    outputWebhookSigningSecret,
    pipelineQ.data,
  ]);

  // Sync rawYaml when switching to YAML mode
  useEffect(() => {
    if (yamlMode) setRawYaml(YAML.stringify(buildDefinition()));
    // eslint-disable-next-line
  }, [yamlMode, buildDefinition]);

  // Step mutations
  const updateStep = (idx: number, patch: Partial<StepDef>) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    );
  };

  const updateConnectorStep = (
    idx: number,
    patch: Partial<ConnectorStepState>,
  ) => {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === idx
          ? (() => {
              const nextConnector: ConnectorStepState = {
                ...defaultConnectorConfig(),
                ...(s.connector || {}),
                ...patch,
              };
              return { ...s, connector: nextConnector };
            })()
          : s,
      ),
    );
  };

  const removeStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
    if (expandedStep >= idx && expandedStep > 0)
      setExpandedStep(expandedStep - 1);
  };

  const addStep = () => {
    const next = steps.length + 1;
    setSteps((prev) => [...prev, newStep(next)]);
    setExpandedStep(steps.length);
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
    setExpandedStep(target);
  };

  const insertPromptToken = (idx: number, token: string) => {
    const target = promptRefs.current[idx];
    if (!target) {
      const current = steps[idx]?.prompt || "";
      updateStep(idx, { prompt: `${current}${current ? " " : ""}${token}` });
      return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next = target.value.slice(0, start) + token + target.value.slice(end);
    updateStep(idx, { prompt: next });

    requestAnimationFrame(() => {
      const node = promptRefs.current[idx];
      if (!node) return;
      const pos = start + token.length;
      node.focus();
      node.setSelectionRange(pos, pos);
    });
  };

  // Variable mutations
  const updateVar = (idx: number, field: "key" | "value", val: string) => {
    setVariables((prev) =>
      prev.map((v, i) => (i === idx ? { ...v, [field]: val } : v)),
    );
  };
  const removeVar = (idx: number) =>
    setVariables((prev) => prev.filter((_, i) => i !== idx));
  const addVar = () =>
    setVariables((prev) => [...prev, { key: "", value: "" }]);

  // Save
  const saveMut = useMutation({
    mutationFn: async () => {
      const definition = buildDefinition();
      return apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`, {
        method: "PUT",
        body: JSON.stringify({ name, description, definition }),
      });
    },
    onSuccess: async () => {
      trackPipelineSaved(pipelineId, steps.length);
      const local = {
        enabled: outputWebhookEnabled,
        from: outputFromStepId || steps[steps.length - 1]?.id || "",
        url: outputWebhookUrl,
        method: outputWebhookMethod,
        signingSecretName: outputWebhookSigningSecret,
      } satisfies OutboundWebhookConfig;

      const persisted = await queryClient.fetchQuery({
        queryKey: ["pipeline", pipelineId],
        queryFn: () => apiFetch<PipelineRecord>(`/api/pipelines/${pipelineId}`),
      });

      const persistedWebhook = normalizeOutboundWebhook(persisted.definition);
      const matches = areOutboundWebhookConfigsEqual(local, persistedWebhook);
      if (matches) {
        setMessage("Pipeline saved ✓");
      } else {
        setMessage(
          "Pipeline saved, but outbound webhook config was not persisted exactly as entered. Please review and save again.",
        );
      }
    },
    onError: (err) =>
      setMessage(err instanceof Error ? err.message : "Save failed"),
  });

  // Run
  const runMut = useMutation({
    mutationFn: () =>
      apiFetch<RunRecord>(`/api/pipelines/${pipelineId}/run`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (run) => {
      trackPipelineRunTriggered(pipelineId, "manual");
      navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
    onError: (err) =>
      setMessage(err instanceof Error ? err.message : "Run failed"),
  });

  const createPipelineSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>(`/api/pipelines/${pipelineId}/secrets`, {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      trackSecretCreated("pipeline");
      setPipelineSecretName("");
      setPipelineSecretValue("");
      setPipelineSecretError(null);
      setPipelineSecretSuccess("Pipeline secret saved");
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to create secret",
      );
    },
  });

  const updatePipelineSecretMut = useMutation({
    mutationFn: (payload: { name: string; value: string }) =>
      apiFetch<SecretRecord>(
        `/api/pipelines/${pipelineId}/secrets/${encodeURIComponent(payload.name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value: payload.value }),
        },
      ),
    onSuccess: (_, payload) => {
      trackSecretUpdated("pipeline");
      setPipelineSecretUpdateName(null);
      setPipelineSecretUpdateValue("");
      setPipelineSecretError(null);
      setPipelineSecretSuccess(`Secret "${payload.name}" updated`);
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to update secret",
      );
    },
  });

  const deletePipelineSecretMut = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ deleted: boolean }>(
        `/api/pipelines/${pipelineId}/secrets/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      trackSecretDeleted("pipeline");
      setPipelineSecretError(null);
      setPipelineSecretSuccess("Secret removed");
      queryClient.invalidateQueries({
        queryKey: ["pipeline-secrets", pipelineId],
      });
    },
    onError: (err) => {
      setPipelineSecretSuccess(null);
      setPipelineSecretError(
        err instanceof ApiError ? err.message : "Failed to delete secret",
      );
    },
  });

  const submitPipelineSecret = () => {
    setPipelineSecretSuccess(null);
    const normalizedName = pipelineSecretName.trim().toUpperCase();
    if (!normalizedName || !pipelineSecretValue.trim()) {
      setPipelineSecretError("Name and value are required");
      return;
    }
    createPipelineSecretMut.mutate({
      name: normalizedName,
      value: pipelineSecretValue,
    });
  };

  const submitPipelineSecretUpdate = () => {
    if (!pipelineSecretUpdateName || !pipelineSecretUpdateValue.trim()) {
      setPipelineSecretError("New secret value is required");
      return;
    }
    setPipelineSecretSuccess(null);
    updatePipelineSecretMut.mutate({
      name: pipelineSecretUpdateName,
      value: pipelineSecretUpdateValue,
    });
  };

  const status = pipelineQ.data?.status || "draft";

  const actions = (
    <div className="flex items-center gap-3">
      <StatusBadge status={status} />
      <button
        type="button"
        className="rounded-lg border border-[var(--text-muted)] px-[18px] py-2.5 text-sm font-medium text-[var(--text-secondary)]"
        onClick={() => runMut.mutate()}
      >
        ▷ Test Run
      </button>
      <button
        type="button"
        className="rounded-lg bg-[var(--accent)] px-[18px] py-2.5 text-sm font-semibold text-[var(--bg-primary)]"
        onClick={() => saveMut.mutate()}
      >
        Save Pipeline
      </button>
    </div>
  );

  return (
    <AppShell
      title={name || "Pipeline Editor"}
      subtitle={description || "Configure your pipeline steps and variables"}
      actions={actions}
    >
      {pipelineQ.isLoading ? (
        <p className="text-sm text-[var(--text-tertiary)]">
          Loading pipeline...
        </p>
      ) : null}
      {pipelineQ.isError ? (
        <p className="text-sm text-red-300">
          {pipelineQ.error instanceof Error
            ? pipelineQ.error.message
            : "Failed to load"}
        </p>
      ) : null}
      {message ? (
        <p className="mb-2 text-sm text-[var(--text-secondary)]">{message}</p>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left panel — 360px on desktop, full width on mobile */}
        <div className="flex w-full shrink-0 flex-col gap-5 lg:w-[360px]">
          {/* Config card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <h2 className="text-[15px] font-semibold">Pipeline Config</h2>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Name
              </span>
              <input
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Description
              </span>
              <input
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>

          {/* Variables card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Variables</h2>
              <button
                type="button"
                onClick={addVar}
                className="text-xs font-medium text-[var(--accent)]"
              >
                + Add
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {variables.map((v, i) => (
                <div
                  key={`var-${v.key || i}`}
                  className="flex items-center gap-2"
                >
                  <input
                    className="flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                    style={{ fontFamily: "var(--font-mono)" }}
                    value={v.key}
                    onChange={(e) => updateVar(i, "key", e.target.value)}
                    placeholder="key"
                  />
                  <input
                    className="flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                    style={{ fontFamily: "var(--font-mono)" }}
                    value={v.value}
                    onChange={(e) => updateVar(i, "value", e.target.value)}
                    placeholder="value"
                  />
                  <button
                    type="button"
                    onClick={() => removeVar(i)}
                    className="shrink-0 rounded-md p-1.5 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400"
                    title="Remove variable"
                  >
                    ×
                  </button>
                </div>
              ))}
              {variables.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No variables defined.
                </p>
              ) : null}
            </div>
          </div>

          {/* Pipeline secrets card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Pipeline Secrets</h2>
              <button
                type="button"
                onClick={submitPipelineSecret}
                disabled={createPipelineSecretMut.isPending}
                className="text-xs font-medium text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createPipelineSecretMut.isPending ? "Saving..." : "+ Add"}
              </button>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Secrets apply only to this pipeline and override global secrets
              with the same name.
            </p>
            <div className="flex items-center gap-2">
              <input
                className="flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs uppercase focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={pipelineSecretName}
                onChange={(e) => setPipelineSecretName(e.target.value)}
                placeholder="name"
              />
              <input
                type="password"
                className="flex-1 rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={pipelineSecretValue}
                onChange={(e) => setPipelineSecretValue(e.target.value)}
                placeholder="value"
              />
              <button
                type="button"
                onClick={submitPipelineSecret}
                disabled={createPipelineSecretMut.isPending}
                className="shrink-0 rounded-md px-2 py-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-inset)] hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {createPipelineSecretMut.isPending ? "..." : "+"}
              </button>
            </div>
            {pipelineSecretError ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {pipelineSecretError}
              </p>
            ) : null}
            {pipelineSecretSuccess ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                {pipelineSecretSuccess}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              {pipelineSecretsQ.isLoading ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Loading pipeline secrets...
                </p>
              ) : null}
              {pipelineSecretsQ.data?.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No pipeline secrets yet.
                </p>
              ) : null}
              {pipelineSecretsQ.data?.map((secret) => (
                <div
                  key={secret.id}
                  className="flex items-center justify-between rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2"
                >
                  <div>
                    <p
                      className="text-xs font-medium uppercase"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {secret.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPipelineSecretError(null);
                        setPipelineSecretSuccess(null);
                        setPipelineSecretUpdateValue("");
                        setPipelineSecretUpdateName(secret.name);
                      }}
                      className="cursor-pointer rounded border border-[var(--divider)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                    >
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        deletePipelineSecretMut.mutate(secret.name)
                      }
                      disabled={deletePipelineSecretMut.isPending}
                      className="cursor-pointer rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pipelineSecretUpdateName ? (
              <div className="rounded-[8px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3">
                <p
                  className="mb-2 text-xs text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Rotate {pipelineSecretUpdateName}
                </p>
                <input
                  type="password"
                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                  value={pipelineSecretUpdateValue}
                  onChange={(e) => setPipelineSecretUpdateValue(e.target.value)}
                  placeholder="New value"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={submitPipelineSecretUpdate}
                    disabled={updatePipelineSecretMut.isPending}
                    className="cursor-pointer rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {updatePipelineSecretMut.isPending
                      ? "Updating..."
                      : "Update"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPipelineSecretUpdateName(null);
                      setPipelineSecretUpdateValue("");
                    }}
                    className="cursor-pointer rounded border border-[var(--divider)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* YAML editor */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">YAML</h2>
              <button
                type="button"
                onClick={() => setYamlMode(!yamlMode)}
                className={`rounded-[6px] px-2.5 py-1 text-[11px] font-semibold ${
                  yamlMode
                    ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                }`}
              >
                {yamlMode ? "Editing YAML" : "View only"}
              </button>
            </div>
            <textarea
              className="min-h-[180px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] p-3 text-xs leading-relaxed focus:border-[var(--accent)] focus:outline-none"
              style={{ fontFamily: "var(--font-mono)" }}
              value={yamlMode ? rawYaml : YAML.stringify(buildDefinition())}
              onChange={(e) => yamlMode && setRawYaml(e.target.value)}
              readOnly={!yamlMode}
            />
          </div>
        </div>

        {/* Right panel — Steps */}
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">
              Steps ({steps.length})
            </h2>
            <button
              type="button"
              onClick={addStep}
              className="flex items-center gap-1.5 rounded-[6px] bg-[var(--accent)] px-3 py-1.5 text-[13px] font-semibold text-[var(--bg-primary)]"
            >
              + Add Step
            </button>
          </div>

          {steps.map((step, idx) => {
            const isExpanded = expandedStep === idx;
            const previousSteps = steps.slice(0, idx);
            const promptTemplateWarning = getPromptTemplateWarning(
              step.prompt,
              steps.map((s) => s.id),
            );
            return (
              <div
                key={step.id}
                className={`rounded-[10px] border bg-[var(--bg-surface)] transition-colors ${
                  isExpanded
                    ? "border-[var(--accent)]"
                    : "border-[var(--divider)]"
                }`}
              >
                {/* Step header — always visible */}
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-5 py-4"
                  onClick={() => setExpandedStep(isExpanded ? -1 : idx)}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`grid size-6 place-items-center rounded-[6px] text-[11px] font-bold ${
                        isExpanded
                          ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                          : "bg-[var(--bg-inset)] text-[var(--text-secondary)]"
                      }`}
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {idx + 1}
                    </div>
                    <span
                      className={`text-sm ${isExpanded ? "font-semibold" : "font-medium"}`}
                    >
                      {step.name || `Step ${idx + 1}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-full bg-[var(--bg-inset)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {step.type === "connector"
                        ? `connector:${step.connector?.provider || "gmail"}`
                        : step.model}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  </div>
                </button>

                {/* Expanded edit form */}
                {isExpanded ? (
                  <div className="border-t border-[var(--divider)] px-5 pb-5 pt-4">
                    <div className="flex flex-col gap-4">
                      {/* Name + Type + Model row */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Step Name
                          </span>
                          <input
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                            value={step.name}
                            onChange={(e) =>
                              updateStep(idx, { name: e.target.value })
                            }
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Step Type
                          </span>
                          <select
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.type}
                            onChange={(e) => {
                              const nextType = e.target.value;
                              updateStep(idx, {
                                type: nextType,
                                connector:
                                  nextType === "connector"
                                    ? step.connector || defaultConnectorConfig()
                                    : undefined,
                              });
                            }}
                          >
                            <option value="llm">llm</option>
                            <option value="transform">transform</option>
                            <option
                              value="connector"
                              disabled={!connectorStepsEnabled}
                            >
                              connector{connectorStepsEnabled ? "" : " (Pro+)"}
                            </option>
                          </select>
                        </label>
                        {step.type !== "connector" ? (
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Model
                            </span>
                            <select
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.model}
                              onChange={(e) =>
                                updateStep(idx, { model: e.target.value })
                              }
                            >
                              {modelOptions.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <div className="rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-xs text-[var(--text-secondary)]">
                            Connector step executes via connectors gateway.
                          </div>
                        )}
                      </div>

                      {step.type !== "connector" ? (
                        <>
                          {/* Prompt */}
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Prompt
                            </span>
                            <textarea
                              className="min-h-[100px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] leading-relaxed focus:border-[var(--accent)] focus:outline-none"
                              value={step.prompt}
                              ref={(el) => {
                                promptRefs.current[idx] = el;
                              }}
                              onChange={(e) =>
                                updateStep(idx, { prompt: e.target.value })
                              }
                              placeholder="Enter the prompt for this step..."
                            />
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(idx, "{{input.topic}}")
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + input.topic
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(idx, "{{vars.language}}")
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + vars.language
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  insertPromptToken(
                                    idx,
                                    "{{env.OPENAI_API_KEY}}",
                                  )
                                }
                                className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                              >
                                + env.OPENAI_API_KEY
                              </button>
                              {previousSteps.length > 0 &&
                              previousSteps.length <= 4
                                ? previousSteps.map((prevStep, prevIdx) => (
                                    <button
                                      key={`${prevStep.id}-token`}
                                      type="button"
                                      onClick={() =>
                                        insertPromptToken(
                                          idx,
                                          `{{steps.${prevStep.id}.output}}`,
                                        )
                                      }
                                      className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                      title={`Also available: {{steps.${prevIdx + 1}.output}}`}
                                    >
                                      + steps.{prevStep.id}.output
                                    </button>
                                  ))
                                : null}
                              {previousSteps.length > 4 ? (
                                <div className="flex items-center gap-1.5">
                                  <select
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                    style={{ fontFamily: "var(--font-mono)" }}
                                    value={selectedPrevStepToken[idx] || ""}
                                    onChange={(e) =>
                                      setSelectedPrevStepToken((prev) => ({
                                        ...prev,
                                        [idx]: e.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">
                                      Select step output...
                                    </option>
                                    {previousSteps.map((prevStep, prevIdx) => (
                                      <option
                                        key={`${prevStep.id}-token-option`}
                                        value={`{{steps.${prevStep.id}.output}}`}
                                      >
                                        {`${prevIdx + 1}. ${prevStep.name || prevStep.id} (${prevStep.id})`}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={!selectedPrevStepToken[idx]}
                                    onClick={() =>
                                      selectedPrevStepToken[idx] &&
                                      insertPromptToken(
                                        idx,
                                        selectedPrevStepToken[idx],
                                      )
                                    }
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-inset)] px-2 py-1 text-[11px] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    + Insert step output
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-[var(--text-muted)]">
                              Supports: <code>{"{{input.field}}"}</code>,{" "}
                              <code>{"{{vars.name}}"}</code>,{" "}
                              <code>{"{{steps.step_1.output}}"}</code>,{" "}
                              <code>{"{{steps.1.output}}"}</code>,{" "}
                              <code>{"{{env.OPENAI_API_KEY}}"}</code>.
                            </p>
                            {promptTemplateWarning ? (
                              <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                                {promptTemplateWarning}
                              </p>
                            ) : null}
                          </label>
                        </>
                      ) : (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {!connectorStepsEnabled ? (
                            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:col-span-2">
                              Connector steps are available on Pro and
                              Enterprise plans. Upgrade to use presets and
                              external tool actions/fetches.
                            </p>
                          ) : null}
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Connector Mode
                            </span>
                            <select
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.mode || "fetch"}
                              onChange={(e) => {
                                updateConnectorStep(idx, {
                                  mode: e.target.value as "fetch" | "action",
                                });
                                setSelectedConnectorPreset((prev) => ({
                                  ...prev,
                                  [idx]: "",
                                }));
                                setSelectedConnectorActionPreset((prev) => ({
                                  ...prev,
                                  [idx]: "",
                                }));
                              }}
                            >
                              <option value="fetch">fetch</option>
                              <option value="action">action</option>
                            </select>
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Provider
                            </span>
                            <select
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.provider || "gmail"}
                              onChange={(e) => {
                                const nextProvider = e.target.value;
                                updateConnectorStep(idx, {
                                  provider: nextProvider,
                                  authSecretName:
                                    step.connector?.authSecretName ||
                                    connectorDefaultSecretName(nextProvider),
                                });
                                setSelectedConnectorPreset((prev) => ({
                                  ...prev,
                                  [idx]: "",
                                }));
                                setSelectedConnectorActionPreset((prev) => ({
                                  ...prev,
                                  [idx]: "",
                                }));
                              }}
                            >
                              <option value="gmail">gmail</option>
                              <option value="github">github</option>
                              <option value="discord">discord</option>
                              <option value="slack">slack</option>
                              <option value="telegram">telegram</option>
                              <option value="linear">linear</option>
                              <option value="jira">jira</option>
                              <option value="monday">monday</option>
                              <option value="s3">s3</option>
                            </select>
                          </label>
                          <label className="flex flex-col gap-1.5 sm:col-span-2">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Auth Secret Name
                            </span>
                            <input
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.authSecretName || ""}
                              onChange={(e) =>
                                updateConnectorStep(idx, {
                                  authSecretName: e.target.value
                                    .trim()
                                    .toUpperCase(),
                                })
                              }
                              placeholder="GMAIL_ACCESS_TOKEN or DISCORD_BOT_TOKEN"
                            />
                          </label>
                          <label className="flex flex-col gap-1.5 sm:col-span-2">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Fetch Query (JSON)
                            </span>
                            <textarea
                              className="min-h-[90px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.query || "{}"}
                              onChange={(e) =>
                                updateConnectorStep(idx, {
                                  query: e.target.value,
                                })
                              }
                            />
                            {(step.connector?.mode || "fetch") === "fetch" &&
                            connectorFetchPresets(
                              step.connector?.provider || "gmail",
                            ).length > 0 ? (
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  value={selectedConnectorPreset[idx] || ""}
                                  onChange={(e) =>
                                    setSelectedConnectorPreset((prev) => ({
                                      ...prev,
                                      [idx]: e.target.value,
                                    }))
                                  }
                                >
                                  <option value="">Select preset...</option>
                                  {connectorFetchPresets(
                                    step.connector?.provider || "gmail",
                                  ).map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                      {preset.label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                                  disabled={!selectedConnectorPreset[idx]}
                                  onClick={() => {
                                    const selected = connectorFetchPresets(
                                      step.connector?.provider || "gmail",
                                    ).find(
                                      (preset) =>
                                        preset.id ===
                                        selectedConnectorPreset[idx],
                                    );
                                    if (!selected) return;
                                    updateConnectorStep(idx, {
                                      query: JSON.stringify(
                                        selected.build(),
                                        null,
                                        2,
                                      ),
                                    });
                                  }}
                                >
                                  Apply preset
                                </button>
                              </div>
                            ) : null}
                          </label>
                          {(step.connector?.mode || "fetch") === "action" ? (
                            <>
                              {connectorActionPresets(
                                step.connector?.provider || "gmail",
                              ).length > 0 ? (
                                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                                  <select
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                                    style={{ fontFamily: "var(--font-mono)" }}
                                    value={
                                      selectedConnectorActionPreset[idx] || ""
                                    }
                                    onChange={(e) =>
                                      setSelectedConnectorActionPreset(
                                        (prev) => ({
                                          ...prev,
                                          [idx]: e.target.value,
                                        }),
                                      )
                                    }
                                  >
                                    <option value="">Select action preset...</option>
                                    {connectorActionPresets(
                                      step.connector?.provider || "gmail",
                                    ).map((preset) => (
                                      <option key={preset.id} value={preset.id}>
                                        {preset.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="rounded border border-[var(--divider)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={
                                      !selectedConnectorActionPreset[idx]
                                    }
                                    onClick={() => {
                                      const selected = connectorActionPresets(
                                        step.connector?.provider || "gmail",
                                      ).find(
                                        (preset) =>
                                          preset.id ===
                                          selectedConnectorActionPreset[idx],
                                      );
                                      if (!selected) return;
                                      updateConnectorStep(idx, {
                                        action: selected.action,
                                        target: selected.target || "",
                                        payload: JSON.stringify(
                                          selected.buildPayload(),
                                          null,
                                          2,
                                        ),
                                      });
                                    }}
                                  >
                                    Apply action preset
                                  </button>
                                </div>
                              ) : null}
                              <label className="flex flex-col gap-1.5">
                                <span className="text-xs font-medium text-[var(--text-secondary)]">
                                  Action
                                </span>
                                <input
                                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  value={step.connector?.action || ""}
                                  onChange={(e) =>
                                    updateConnectorStep(idx, {
                                      action: e.target.value,
                                    })
                                  }
                                  placeholder="post_message"
                                />
                              </label>
                              <label className="flex flex-col gap-1.5">
                                <span className="text-xs font-medium text-[var(--text-secondary)]">
                                  Target
                                </span>
                                <input
                                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  value={step.connector?.target || ""}
                                  onChange={(e) =>
                                    updateConnectorStep(idx, {
                                      target: e.target.value,
                                    })
                                  }
                                  placeholder="channel / issue / bucket"
                                />
                              </label>
                              <label className="flex flex-col gap-1.5 sm:col-span-2">
                                <span className="text-xs font-medium text-[var(--text-secondary)]">
                                  Payload (JSON)
                                </span>
                                <textarea
                                  className="min-h-[90px] w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  value={step.connector?.payload || "{}"}
                                  onChange={(e) =>
                                    updateConnectorStep(idx, {
                                      payload: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1.5">
                                <span className="text-xs font-medium text-[var(--text-secondary)]">
                                  Idempotency Key
                                </span>
                                <input
                                  className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  value={step.connector?.idempotencyKey || ""}
                                  onChange={(e) =>
                                    updateConnectorStep(idx, {
                                      idempotencyKey: e.target.value,
                                    })
                                  }
                                  placeholder="{{input.request_id}}"
                                />
                              </label>
                            </>
                          ) : null}
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Max Items
                            </span>
                            <input
                              type="number"
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.maxItems ?? 25}
                              min={1}
                              max={1000}
                              onChange={(e) =>
                                updateConnectorStep(idx, {
                                  maxItems: Number(e.target.value),
                                })
                              }
                            />
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">
                              Privacy
                            </span>
                            <select
                              className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                              style={{ fontFamily: "var(--font-mono)" }}
                              value={step.connector?.privacyMode || "strict"}
                              onChange={(e) =>
                                updateConnectorStep(idx, {
                                  privacyMode: e.target.value as
                                    | "strict"
                                    | "balanced",
                                })
                              }
                            >
                              <option value="strict">strict</option>
                              <option value="balanced">balanced</option>
                            </select>
                          </label>
                        </div>
                      )}

                      {/* Config row — Output Format, Timeout, Retries */}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Output Format
                          </span>
                          <select
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.outputFormat || "text"}
                            disabled={step.type === "connector"}
                            onChange={(e) =>
                              updateStep(idx, { outputFormat: e.target.value })
                            }
                          >
                            <option value="text">text</option>
                            <option value="json">json</option>
                            <option value="markdown">markdown</option>
                          </select>
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Timeout (s)
                          </span>
                          <input
                            type="number"
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.timeout ?? 30}
                            onChange={(e) =>
                              updateStep(idx, {
                                timeout: Number(e.target.value),
                              })
                            }
                            min={1}
                            max={300}
                          />
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className="text-xs font-medium text-[var(--text-secondary)]">
                            Retries
                          </span>
                          <input
                            type="number"
                            className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3 py-2 text-xs focus:border-[var(--accent)] focus:outline-none"
                            style={{ fontFamily: "var(--font-mono)" }}
                            value={step.retries ?? 2}
                            onChange={(e) =>
                              updateStep(idx, {
                                retries: Number(e.target.value),
                              })
                            }
                            min={0}
                            max={10}
                          />
                        </label>
                      </div>

                      {/* Step actions */}
                      <div className="flex items-center justify-between border-t border-[var(--divider)] pt-3">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => moveStep(idx, -1)}
                            disabled={idx === 0}
                            className="rounded-[6px] border border-[var(--divider)] px-2 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-30"
                            title="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => moveStep(idx, 1)}
                            disabled={idx === steps.length - 1}
                            className="rounded-[6px] border border-[var(--divider)] px-2 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-30"
                            title="Move down"
                          >
                            ↓
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeStep(idx)}
                          className="rounded-[6px] border border-red-500/30 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10"
                        >
                          Remove step
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {steps.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-[var(--divider)] p-8 text-center">
              <p className="text-sm text-[var(--text-tertiary)]">
                No steps yet.
              </p>
              <button
                type="button"
                onClick={addStep}
                className="mt-3 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)]"
              >
                Add your first step
              </button>
            </div>
          ) : null}

          {/* Output webhook card */}
          <div className="flex flex-col gap-4 rounded-[10px] border border-[var(--divider)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Output Webhook</h2>
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={outputWebhookEnabled}
                  onChange={(e) => setOutputWebhookEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">
                Output From Step
              </span>
              <select
                className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
                value={outputFromStepId}
                onChange={(e) => setOutputFromStepId(e.target.value)}
              >
                {steps.map((step) => (
                  <option key={`out-from-${step.id}`} value={step.id}>
                    {step.id}
                  </option>
                ))}
              </select>
            </label>
            {outputWebhookEnabled ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Webhook URL
                  </span>
                  <input
                    className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                    value={outputWebhookUrl}
                    onChange={(e) => setOutputWebhookUrl(e.target.value)}
                    placeholder="https://example.com/hooks/stepiq"
                  />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Method
                    </span>
                    <select
                      className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 text-[13px] focus:border-[var(--accent)] focus:outline-none"
                      style={{ fontFamily: "var(--font-mono)" }}
                      value={outputWebhookMethod}
                      onChange={(e) =>
                        setOutputWebhookMethod(
                          (e.target.value as "POST" | "PUT" | "GET") || "POST",
                        )
                      }
                    >
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="GET">GET</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      Signing Secret Name
                    </span>
                    <input
                      className="w-full rounded-[6px] border border-[var(--divider)] bg-[var(--bg-inset)] px-3.5 py-2.5 font-[var(--font-mono)] text-[13px] uppercase focus:border-[var(--accent)] focus:outline-none"
                      value={outputWebhookSigningSecret}
                      onChange={(e) =>
                        setOutputWebhookSigningSecret(e.target.value)
                      }
                      placeholder="WEBHOOK_SIGNING_SECRET"
                    />
                  </label>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active" || status === "running";
  const bg = isActive ? "#22C55E20" : "#EAB30820";
  const fg = isActive ? "#22C55E" : "#EAB308";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: bg, color: fg, fontFamily: "var(--font-mono)" }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ background: fg }}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
