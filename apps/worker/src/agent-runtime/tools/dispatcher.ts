import { curlTool } from "./curl.js";
import { extractJsonTool } from "./extract-json.js";
import { ghTool } from "./gh.js";
import { gogcliTool } from "./gogcli.js";
import {
  effectiveAllowlist,
  parseGlobalAllowlist,
  runCommand,
} from "./helpers.js";
import { httpRequestTool } from "./http-request.js";
import { jsTool } from "./js.js";
import { templateRenderTool } from "./template-render.js";
import type {
  AgentLogEntry,
  AgentTool,
  AgentToolType,
  ToolExecutionContext,
  ToolHandler,
  ToolResultEnvelope,
} from "./types.js";

const DEFAULT_SCHEMAS: Record<AgentToolType, Record<string, unknown>> = {
  http_request: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      method: { type: "string", description: "HTTP method (GET, POST, etc.)" },
      headers: { type: "object", description: "HTTP headers" },
      body: { type: "string", description: "Request body" },
    },
    required: ["url"],
  },
  curl: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      method: { type: "string", description: "HTTP method" },
      headers: { type: "object", description: "HTTP headers" },
      body: { type: "string", description: "Request body" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["url"],
  },
  extract_json: {
    type: "object",
    properties: {
      text: { type: "string", description: "JSON text to parse" },
      path: { type: "string", description: "JSON path to extract" },
    },
    required: ["text"],
  },
  template_render: {
    type: "object",
    properties: {
      template: { type: "string", description: "Handlebars template" },
      context: { type: "object", description: "Template variables" },
    },
    required: ["template"],
  },
  js: {
    type: "object",
    properties: {},
  },
  gh: {
    type: "object",
    properties: {
      token: { type: "string", description: "GitHub token for gh auth" },
      path: { type: "string", description: "GitHub API path (for example /user/repos)" },
      method: { type: "string", description: "HTTP method" },
      headers: { type: "object", description: "HTTP headers" },
      body: { type: "object", description: "Optional request body" },
      paginate: { type: "boolean", description: "Whether to paginate results" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["token", "path"],
  },
  gogcli: {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments passed to gog",
      },
      argv: {
        type: "array",
        items: { type: "string" },
        description: "Alias for args",
      },
      token: { type: "string", description: "Optional GitHub token" },
      env: { type: "object", description: "Extra environment variables" },
      stdin: { type: "string", description: "Optional stdin payload" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds" },
    },
    required: ["args"],
  },
};

export function applyDefaultSchema(tool: AgentTool): AgentTool {
  if (tool.input_schema && Object.keys(tool.input_schema).length > 0) return tool;
  const fallback = DEFAULT_SCHEMAS[tool.type];
  if (!fallback) return tool;
  return { ...tool, input_schema: fallback };
}

const handlers: Record<AgentToolType, ToolHandler> = {
  http_request: httpRequestTool,
  extract_json: extractJsonTool,
  template_render: templateRenderTool,
  js: jsTool,
  curl: curlTool,
  gh: ghTool,
  gogcli: gogcliTool,
};

type LogSink = (entry: AgentLogEntry) => void;

const MODEL_CONTEXT_STRING_MAX_LENGTH = 8_000;
const MODEL_CONTEXT_ARRAY_MAX_ITEMS = 20;
const MODEL_CONTEXT_OBJECT_MAX_KEYS = 24;
const MODEL_CONTEXT_MAX_DEPTH = 4;
const INTERESTING_HEADER_KEYS = new Set([
  "content-type",
  "content-length",
  "location",
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
]);

function truncateForModel(value: string): { value: string; changed: boolean } {
  if (value.length <= MODEL_CONTEXT_STRING_MAX_LENGTH) {
    return { value, changed: false };
  }
  return {
    value: `${value.slice(0, MODEL_CONTEXT_STRING_MAX_LENGTH)}… [truncated ${value.length - MODEL_CONTEXT_STRING_MAX_LENGTH} chars for model context]`,
    changed: true,
  };
}

function compactHeadersForModel(
  value: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const entries = Object.entries(value);
  const preferred = entries.filter(([key]) =>
    INTERESTING_HEADER_KEYS.has(key.toLowerCase()),
  );
  const fallback = entries.filter(
    ([key]) => !INTERESTING_HEADER_KEYS.has(key.toLowerCase()),
  );
  const selected = [...preferred, ...fallback].slice(0, 8);
  const out: Record<string, unknown> = {};
  let changed = selected.length < entries.length;
  for (const [key, item] of selected) {
    const compacted = compactToolValueForModel(item, 1);
    out[key] = compacted.value;
    changed = changed || compacted.changed;
  }
  return { value: out, changed };
}

function compactToolValueForModel(
  value: unknown,
  depth = 0,
): { value: unknown; changed: boolean } {
  if (value == null) return { value, changed: false };
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return { value, changed: false };
  }
  if (typeof value === "string") {
    return truncateForModel(value);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MODEL_CONTEXT_ARRAY_MAX_ITEMS);
    let changed = items.length < value.length;
    const out = items.map((item) => {
      const compacted = compactToolValueForModel(item, depth + 1);
      changed = changed || compacted.changed;
      return compacted.value;
    });
    return { value: out, changed };
  }
  if (typeof value === "object") {
    if (depth >= MODEL_CONTEXT_MAX_DEPTH) {
      return { value: "[truncated-depth-for-model-context]", changed: true };
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MODEL_CONTEXT_OBJECT_MAX_KEYS,
    );
    let changed =
      entries.length <
      Object.keys(value).length;
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (
        key === "headers" &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item)
      ) {
        const compactedHeaders = compactHeadersForModel(
          item as Record<string, unknown>,
        );
        out[key] = compactedHeaders.value;
        changed = changed || compactedHeaders.changed;
        continue;
      }
      const compacted = compactToolValueForModel(item, depth + 1);
      out[key] = compacted.value;
      changed = changed || compacted.changed;
    }
    return { value: out, changed };
  }
  return { value: String(value), changed: true };
}

export function compactToolResultForModel(
  result: ToolResultEnvelope,
): ToolResultEnvelope {
  const compacted = compactToolValueForModel(result);
  if (
    !compacted.changed ||
    !compacted.value ||
    typeof compacted.value !== "object" ||
    Array.isArray(compacted.value)
  ) {
    return compacted.value as ToolResultEnvelope;
  }
  return {
    ...(compacted.value as ToolResultEnvelope),
    model_context_truncated: true,
  };
}

function logToolEvent(
  label: string,
  message: string,
  data: Record<string, unknown> | undefined,
  sink?: LogSink,
  meta?: {
    level?: AgentLogEntry["level"];
    event?: string;
  },
) {
  const level = meta?.level || "info";
  const event = meta?.event || "tool_call_event";
  if (data) {
    console.log(`[agent:${label}] ${message}`, data);
  } else {
    console.log(`[agent:${label}] ${message}`);
  }
  sink?.({
    ts: new Date().toISOString(),
    level,
    source: "tool_bridge",
    event,
    message,
    ...(data ? { data } : {}),
  });
}

export async function executeToolCall(
  payloadJson: string,
  options: {
    tools: AgentTool[];
    debugLabel: string;
    onLog?: LogSink;
  },
): Promise<string> {
  let payload: { name: string; arguments: string; network_allowlist?: string[] };
  try {
    payload = JSON.parse(payloadJson) as {
      name: string;
      arguments: string;
      network_allowlist?: string[];
    };
  } catch {
    return JSON.stringify({ ok: false, error: "Invalid tool payload JSON" });
  }

  const tool = options.tools.find((item) => item.name === payload.name);
  if (!tool) {
    logToolEvent(
      options.debugLabel,
      "Tool lookup failed",
      { tool: payload.name },
      options.onLog,
      { level: "warn", event: "tool_lookup_failed" },
    );
    return JSON.stringify({ ok: false, error: `Unknown tool: ${payload.name}` });
  }

  const startedAt = Date.now();
  let args: Record<string, unknown>;
  try {
    args = payload.arguments ? (JSON.parse(payload.arguments) as Record<string, unknown>) : {};
  } catch {
    logToolEvent(
      options.debugLabel,
      "Tool call failed",
      {
        tool: tool.name,
        type: tool.type,
        duration_ms: Date.now() - startedAt,
        error: "Invalid tool arguments JSON",
      },
      options.onLog,
      { level: "error", event: "tool_call_failed" },
    );
    return JSON.stringify({ ok: false, error: "Invalid tool arguments JSON" });
  }

  const globalList = parseGlobalAllowlist();
  const localList = (payload.network_allowlist || []).map((x) => x.toLowerCase());
  const allowedList = effectiveAllowlist(globalList, localList);

  logToolEvent(
    options.debugLabel,
    "Tool call started",
    {
      tool: tool.name,
      type: tool.type,
      args,
    },
    options.onLog,
    { event: "tool_call_started" },
  );

  try {
    const context: ToolExecutionContext = {
      tool,
      debugLabel: options.debugLabel,
      allowedList,
      runCommand,
    };
    const handler = handlers[tool.type];
    const result = (await handler(args, context)) as ToolResultEnvelope;
    const event = result.ok ? "tool_call_completed" : "tool_call_failed";
    logToolEvent(
      options.debugLabel,
      result.ok ? "Tool call completed" : "Tool call failed",
      {
        tool: tool.name,
        type: tool.type,
        duration_ms: Date.now() - startedAt,
        args,
        result,
      },
      options.onLog,
      { level: result.ok ? "info" : "error", event },
    );
    const modelResult = compactToolResultForModel(result);
    const rawResultJson = JSON.stringify(result);
    const modelResultJson = JSON.stringify(modelResult);
    if (modelResultJson.length < rawResultJson.length) {
      logToolEvent(
        options.debugLabel,
        "Tool result compacted for model context",
        {
          tool: tool.name,
          type: tool.type,
          original_chars: rawResultJson.length,
          model_chars: modelResultJson.length,
        },
        options.onLog,
        { event: "tool_result_compacted" },
      );
    }
    return modelResultJson;
  } catch (error) {
    logToolEvent(
      options.debugLabel,
      "Tool call failed",
      {
        tool: tool.name,
        type: tool.type,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        args,
      },
      options.onLog,
      { level: "error", event: "tool_call_failed" },
    );
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
