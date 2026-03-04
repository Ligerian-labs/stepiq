import {
  runAnyLLMAgentStep,
  type AnyLLMAgentResult,
  type AnyLLMProvider,
} from "@stepiq/anyllm-runtime";
import { SUPPORTED_MODELS } from "../core-adapter.js";
import { applyDefaultSchema, executeToolCall } from "./tools/dispatcher.js";
import type { AgentLogEntry, AgentTool } from "./tools/types.js";

interface AgentConfig {
  max_turns: number;
  max_duration_seconds: number;
  max_tool_calls: number;
  allow_parallel_tools?: boolean;
  tools?: AgentTool[];
  network_allowlist?: string[];
}

interface RuntimeInput {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  output_format?: "text" | "json" | "markdown";
  api_keys?: Record<string, string | undefined>;
  agent: AgentConfig;
  debug_label?: string;
  on_log?: (entry: AgentLogEntry) => void;
}

export interface AgentRuntimeResult extends AnyLLMAgentResult {}

export type { AgentLogEntry };

function forwardWasmLog(
  label: string,
  payloadJson: string,
  sink?: (entry: AgentLogEntry) => void,
) {
  try {
    const entry = JSON.parse(payloadJson) as AgentLogEntry;
    if (entry.data) {
      console.log(`[agent:${label}] ${entry.message}`, entry.data);
    } else {
      console.log(`[agent:${label}] ${entry.message}`);
    }
    sink?.(entry);
  } catch (error) {
    console.warn(`[agent:${label}] Failed to parse wasm log payload`, {
      error: error instanceof Error ? error.message : String(error),
      payloadJson,
    });
  }
}

function agentLog(
  label: string,
  message: string,
  data?: Record<string, unknown>,
  sink?: (entry: AgentLogEntry) => void,
  meta?: {
    level?: AgentLogEntry["level"];
    source?: AgentLogEntry["source"];
    event?: string;
  },
) {
  const level = meta?.level || "info";
  const source = meta?.source || "agent_runtime";
  const event = meta?.event || "runtime_event";
  if (data) {
    console.log(`[agent:${label}] ${message}`, data);
  } else {
    console.log(`[agent:${label}] ${message}`);
  }
  sink?.({
    ts: new Date().toISOString(),
    level,
    source,
    event,
    message,
    ...(data ? { data } : {}),
  });
}

function resolveProvider(model: string): AnyLLMProvider {
  const normalized = model.trim().toLowerCase();
  const info = SUPPORTED_MODELS.find((m) => m.id.toLowerCase() === normalized);
  if (!info) throw new Error(`Unsupported model: ${model}`);
  return info.provider as AnyLLMProvider;
}

function normalizeMaxTokensForModel(
  model: string,
  maxTokens?: number,
): number | undefined {
  if (!maxTokens) return maxTokens;
  if (model.trim().toLowerCase().startsWith("gpt-5")) return undefined;
  return maxTokens;
}

export async function runAgentRuntime(input: RuntimeInput): Promise<AgentRuntimeResult> {
  const debugLabel = input.debug_label || "run";
  const onLog = input.on_log;
  const tools = (input.agent.tools || []).map(applyDefaultSchema);
  const provider = resolveProvider(input.model);
  const startedAt = Date.now();

  agentLog(
    debugLabel,
    "Agent step started",
    {
      provider,
      model: input.model,
      max_turns: input.agent.max_turns,
      max_duration_seconds: input.agent.max_duration_seconds,
      max_tool_calls: input.agent.max_tool_calls,
      tool_count: tools.length,
    },
    onLog,
    { event: "agent_step_started" },
  );

  try {
    const result = await runAnyLLMAgentStep(
      {
        provider,
        model: input.model,
        prompt: input.prompt,
        system: input.system,
        temperature: input.temperature,
        max_tokens: normalizeMaxTokensForModel(input.model, input.max_tokens),
        output_format: input.output_format,
        api_keys: input.api_keys,
        agent: input.agent as unknown as import("@stepiq/anyllm-runtime").AnyLLMAgentConfig,
      },
      {
        toolInvoker: (payloadJson: string) =>
          executeToolCall(payloadJson, {
            tools,
            debugLabel,
            onLog,
          }),
        agentLogger: (payloadJson: string) =>
          forwardWasmLog(debugLabel, payloadJson, onLog),
      },
    );

    agentLog(
      debugLabel,
      "Agent step completed",
      {
        turns_used: result.turns_used,
        total_tokens: result.total_tokens,
        tool_calls_total: result.tool_calls_total,
        tool_calls_success: result.tool_calls_success,
        tool_calls_failed: result.tool_calls_failed,
        duration_ms: Date.now() - startedAt,
      },
      onLog,
      { event: "agent_step_completed" },
    );

    return result;
  } catch (error) {
    agentLog(
      debugLabel,
      "Agent step failed",
      {
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startedAt,
      },
      onLog,
      { level: "error", event: "agent_step_failed" },
    );
    throw error;
  }
}
