export type AgentToolType =
  | "http_request"
  | "extract_json"
  | "template_render"
  | "js"
  | "curl"
  | "gh"
  | "gogcli";

export interface AgentTool {
  type: AgentToolType;
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  js_source?: string;
}

export interface AgentLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  source: "agent_runtime" | "tool_bridge" | "wasm";
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolResultEnvelope {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  stdout?: string;
  stderr?: string;
  parsed_json?: unknown;
  truncated?: boolean;
  duration_ms?: number;
  error?: string;
  [key: string]: unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export type RunCommandFn = (
  command: string,
  argv: string[],
  options?: {
    env?: Record<string, string | undefined>;
    stdin?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
) => Promise<CommandResult>;

export interface ToolExecutionContext {
  tool: AgentTool;
  debugLabel: string;
  allowedList: string[];
  runCommand: RunCommandFn;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResultEnvelope>;
