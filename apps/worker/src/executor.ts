import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import Handlebars from "handlebars";
import postgres from "postgres";
import { serverTrack } from "./analytics.js";
import {
  PLAN_LIMITS,
  type Plan,
  type PipelineDefinition,
  type RunFundingMode,
  type StepTraceStatus,
  type TraceEventKind,
  MARKUP_PERCENTAGE,
  SUPPORTED_MODELS,
  providerSecretNames,
  TOKENS_PER_CREDIT,
  createKmsProvider,
  decryptSecret,
  redactSecrets,
} from "./core-adapter.js";
import {
  pipelines,
  pipelineVersions,
  runs,
  stepExecutions,
  stepTraceEvents,
  userSecrets,
  users,
} from "./db-executor.js";
import { callModel } from "./model-router.js";
import {
  runAgentRuntime,
  type AgentLogEntry as RuntimeAgentLogEntry,
} from "./agent-runtime/runtime.js";
import { applyDefaultSchema } from "./agent-runtime/tools/dispatcher.js";
import { deliverWebhookWithRetry } from "./webhook-delivery.js";

const dbUrl =
  process.env.DATABASE_URL || "postgres://stepiq:stepiq@localhost:5432/stepiq";
const client = postgres(dbUrl);
const db = drizzle(client);

type PersistedAgentLogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  source: "agent_runtime" | "tool_bridge" | "wasm";
  event: string;
  message: string;
  data?: unknown;
};

type PersistedTraceEvent = {
  seq: number;
  step_seq: number;
  kind: TraceEventKind;
  turn?: number | null;
  payload?: unknown;
};

type AgentTurnTraceRecord = {
  turn?: number;
  assistant?: string;
  finish_reason?: string;
  tool_calls?: Array<{
    tool_name?: string;
    args?: string;
    result?: string;
    error?: string;
  }>;
};

const SAFE_AGENT_TOOL_TYPES = [
  "http_request",
  "extract_json",
  "template_render",
  "curl",
] as const;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("context deadline exceeded") ||
    message.includes("deadline exceeded") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function hasToolActivity(logs: PersistedAgentLogEntry[]): boolean {
  return logs.some((entry) =>
    [
      "tool_call_started",
      "tool_call_completed",
      "tool_call_failed",
      "tool_call_skipped",
    ].includes(entry.event),
  );
}

function extractLastSuccessfulToolResult(
  logs: PersistedAgentLogEntry[],
): unknown | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry.event !== "tool_call_completed") continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Record<string, unknown>;
    const result = data.result;
    if (!result || typeof result !== "object") continue;
    const ok = (result as Record<string, unknown>).ok;
    if (ok === true) return result;
  }
  return null;
}

const LOG_MAX_STRING_LENGTH = 4096;
const LOG_MAX_DEPTH = 6;
const SENSITIVE_KEY_RE =
  /(?:authorization|api[-_]?key|token|secret|password|cookie|set-cookie|x-api-key)/i;

function isMissingPipelineIdColumnError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  if (message.includes("pipeline_id") && message.includes("does not exist")) {
    return true;
  }
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: string; message?: string };
  return (
    (err.code === "42703" || message.includes("42703")) &&
    ((err.message?.includes("pipeline_id") ?? false) ||
      (err.message?.includes("user_secrets.pipeline_id") ?? false) ||
      message.includes("pipeline_id"))
  );
}

function resolvePlatformApiKeys() {
  return {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    zai: process.env.ZAI_API_KEY,
  };
}

function truncateLogString(value: string): string {
  if (value.length <= LOG_MAX_STRING_LENGTH) return value;
  return `${value.slice(0, LOG_MAX_STRING_LENGTH)}… [truncated ${value.length - LOG_MAX_STRING_LENGTH} chars]`;
}

function sanitizeLogPayload(
  value: unknown,
  plainSecrets: string[],
  depth = 0,
): unknown {
  if (depth > LOG_MAX_DEPTH) return "[truncated-depth]";
  if (value == null) return value;
  if (typeof value === "string") {
    return truncateLogString(redactSecrets(value, plainSecrets));
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeLogPayload(item, plainSecrets, depth + 1),
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      200,
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitizeLogPayload(item, plainSecrets, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sanitizeAgentLogEntry(
  entry: RuntimeAgentLogEntry,
  plainSecrets: string[],
): PersistedAgentLogEntry {
  return {
    ts: entry.ts,
    level: entry.level,
    source: entry.source,
    event: entry.event,
    message: redactSecrets(entry.message, plainSecrets),
    ...(entry.data
      ? { data: sanitizeLogPayload(entry.data, plainSecrets) }
      : {}),
  };
}

function sanitizeTracePayload(value: unknown, plainSecrets: string[]): unknown {
  return sanitizeLogPayload(value, plainSecrets);
}

function traceEventKindFromAgentLog(
  entry: PersistedAgentLogEntry,
): TraceEventKind | null {
  switch (entry.event) {
    case "agent_step_started":
      return "agent.started";
    case "agent_step_completed":
      return "agent.completed";
    case "agent_step_failed":
      return "agent.failed";
    case "agent_turn_started":
      return "turn.started";
    case "agent_turn_response_received":
      return "turn.completed";
    case "tool_call_started":
      return "tool.call.started";
    case "tool_call_completed":
      return "tool.result.completed";
    case "tool_call_failed":
    case "tool_lookup_failed":
      return "tool.result.failed";
    default:
      return null;
  }
}

function traceTurnFromAgentLog(entry: PersistedAgentLogEntry): number | null {
  const turn =
    entry.data &&
    typeof entry.data === "object" &&
    "turn" in entry.data
      ? (entry.data as Record<string, unknown>).turn
      : null;
  return typeof turn === "number" ? turn : null;
}

function tracePayloadFromAgentLog(
  entry: PersistedAgentLogEntry,
): Record<string, unknown> {
  const payload =
    entry.data && typeof entry.data === "object"
      ? { ...(entry.data as Record<string, unknown>) }
      : {};
  if (!("message" in payload)) payload.message = entry.message;
  if (!("source" in payload)) payload.source = entry.source;
  if (!("level" in payload)) payload.level = entry.level;
  if (!("logged_at" in payload)) payload.logged_at = entry.ts;
  return payload;
}

function extractTurnTraceEvents(
  trace: unknown,
  plainSecrets: string[],
): Array<{
  kind: TraceEventKind;
  turn?: number | null;
  payload?: unknown;
}> {
  if (!Array.isArray(trace)) return [];
  const out: Array<{
    kind: TraceEventKind;
    turn?: number | null;
    payload?: unknown;
  }> = [];

  for (const rawTurn of trace as AgentTurnTraceRecord[]) {
    const turn = typeof rawTurn?.turn === "number" ? rawTurn.turn : null;
    out.push({
      kind: "turn.started",
      turn,
      payload: sanitizeTracePayload(
        {
          finish_reason: rawTurn?.finish_reason || null,
        },
        plainSecrets,
      ),
    });

    if (typeof rawTurn?.assistant === "string" && rawTurn.assistant.trim()) {
      out.push({
        kind: "assistant.text.completed",
        turn,
        payload: sanitizeTracePayload(
          {
            text: rawTurn.assistant,
            finish_reason: rawTurn.finish_reason || null,
          },
          plainSecrets,
        ),
      });
    }

    out.push({
      kind: "turn.completed",
      turn,
      payload: sanitizeTracePayload(
        {
          finish_reason: rawTurn?.finish_reason || null,
          tool_call_count: Array.isArray(rawTurn?.tool_calls)
            ? rawTurn.tool_calls.length
            : 0,
        },
        plainSecrets,
      ),
    });
  }

  return out;
}

export async function executePipeline(runId: string) {
  const runStartMs = Date.now();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`Run ${runId} not found`);

  const [runUser] = await db
    .select({ plan: users.plan, creditsRemaining: users.creditsRemaining })
    .from(users)
    .where(eq(users.id, run.userId))
    .limit(1);

  const [version] = await db
    .select()
    .from(pipelineVersions)
    .where(
      and(
        eq(pipelineVersions.pipelineId, run.pipelineId),
        eq(pipelineVersions.version, run.pipelineVersion),
      ),
    )
    .limit(1);
  let definition = version?.definition as unknown as PipelineDefinition;
  if (!definition) {
    const [pipeline] = await db
      .select({
        id: pipelines.id,
        version: pipelines.version,
        definition: pipelines.definition,
      })
      .from(pipelines)
      .where(eq(pipelines.id, run.pipelineId))
      .limit(1);

    definition = pipeline?.definition as unknown as PipelineDefinition;
    if (!definition) throw new Error("Pipeline definition not found");

    // Backfill missing pipeline_versions rows for legacy chat-created pipelines.
    await db
      .insert(pipelineVersions)
      .values({
        pipelineId: run.pipelineId,
        version: run.pipelineVersion,
        definition,
      })
      .onConflictDoNothing();
  }

  const runStartedAt = new Date();
  await db
    .update(runs)
    .set({ status: "running", startedAt: runStartedAt })
    .where(eq(runs.id, runId));

  let envSecrets: { values: Record<string, string>; plainValues: string[] } = {
    values: {},
    plainValues: [],
  };
  const runtimeVars = definition.variables || {};
  let context: Record<string, unknown> = {
    input: run.inputData,
    vars: runtimeVars,
    // Backward-compat alias for chat-generated templates using {{variables.*}}.
    variables: runtimeVars,
    env: {},
    steps: {} as Record<string, { output: unknown }>,
  };

  let totalTokens = 0;
  let totalCostCents = 0;
  let totalModelCostCents = 0;
  let totalToolCostCents = 0;
  let totalToolCalls = 0;
  let runTraceSeq = 0;
  let currentStepLabel = "initializing";
  let creditsDeducted = false;
  const userPlan = (
    (runUser?.plan || "free") in PLAN_LIMITS ? runUser?.plan || "free" : "free"
  ) as Plan;
  const rawFundingMode =
    ((run.fundingMode || "legacy") as RunFundingMode) || "legacy";
  const fundingMode: RunFundingMode =
    rawFundingMode === "legacy" &&
    (userPlan === "starter" || userPlan === "pro") &&
    (runUser.creditsRemaining || 0) > 0
      ? "app_credits"
      : rawFundingMode;
  const platformApiKeys = resolvePlatformApiKeys();
  console.log(`🔐 Run ${runId} funding mode: ${fundingMode}`, {
    userPlan: runUser?.plan || "unknown",
    hasPlatformOpenAIKey: Boolean(platformApiKeys.openai),
  });
  console.log(`🚀 Run ${runId} started`, {
    pipelineId: run.pipelineId,
    pipelineVersion: run.pipelineVersion,
    steps: definition.steps.length,
    triggerType: run.triggerType,
  });

  const heartbeat = setInterval(() => {
    console.log(`⏳ Run ${runId} heartbeat`, {
      elapsed_ms: Date.now() - runStartMs,
      current_step: currentStepLabel,
      total_tokens: totalTokens,
      total_cost_cents: totalCostCents,
    });
  }, 5000);

  try {
    console.log(`🔐 Run ${runId} resolving secrets...`);
    envSecrets = await resolveUserSecrets(
      run.userId,
      run.pipelineId,
      definition,
      db,
      getOutputSigningSecretNames(definition),
      {
        includeProviderSecrets: fundingMode !== "app_credits",
      },
    );
    console.log(`🔐 Run ${runId} secrets resolved`, {
      count: Object.keys(envSecrets.values).length,
    });
    context = {
      ...context,
      env: envSecrets.values,
    };

    for (let i = 0; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      currentStepLabel = `${step.id} (${i + 1}/${definition.steps.length})`;
      console.log(`▶️ Run ${runId} step started`, {
        step_id: step.id,
        index: i,
        type: step.type || "llm",
        model: step.model || "gpt-5.2",
      });

      const [stepExec] = await db
        .insert(stepExecutions)
        .values({
          runId,
          stepId: step.id,
          stepIndex: i,
          model: step.model || null,
          status: "running",
          startedAt: new Date(),
        })
        .returning();

      const agentLogs: PersistedAgentLogEntry[] = [];
      let lastAgentLogsPersistMs = 0;
      let pendingAgentLogPersist: Promise<void> | null = null;
      let stepTraceSeq = 0;
      let traceWriteChain: Promise<void> = Promise.resolve();
      const maybePersistAgentLogs = async (force = false) => {
        const now = Date.now();
        if (pendingAgentLogPersist) {
          if (force) await pendingAgentLogPersist;
          return;
        }
        if (!force && now - lastAgentLogsPersistMs < 600) return;
        lastAgentLogsPersistMs = now;
        const snapshot = [...agentLogs];
        pendingAgentLogPersist = db
          .update(stepExecutions)
          .set({ agentLogs: snapshot } as Record<string, unknown>)
          .where(eq(stepExecutions.id, stepExec.id))
          .then(() => undefined)
          .catch((error) => {
            console.warn(`⚠️ Run ${runId} failed persisting live agent logs`, {
              step_id: step.id,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            pendingAgentLogPersist = null;
          });
        await pendingAgentLogPersist;
      };

      const appendTraceEvent = async (
        kind: TraceEventKind,
        payload?: unknown,
        options?: {
          turn?: number | null;
          traceStatus?: StepTraceStatus;
        },
      ) => {
        stepTraceSeq += 1;
        runTraceSeq += 1;
        const traceStatus = options?.traceStatus || "streaming";
        const tracePayload =
          payload === undefined
            ? undefined
            : sanitizeTracePayload(payload, envSecrets.plainValues);
        const traceInsertValues: typeof stepTraceEvents.$inferInsert = {
          stepExecutionId: stepExec.id,
          runId,
          stepId: step.id,
          seq: runTraceSeq,
          stepSeq: stepTraceSeq,
          kind,
          turn: options?.turn ?? null,
          ...(tracePayload === undefined ? {} : { payload: tracePayload }),
        };

        try {
          await db.insert(stepTraceEvents).values(traceInsertValues);

          await db
            .update(stepExecutions)
            .set({
              traceEventCount: stepTraceSeq,
              latestTraceSeq: stepTraceSeq,
              traceStatus,
            } as Record<string, unknown>)
            .where(eq(stepExecutions.id, stepExec.id));
        } catch (error) {
          console.warn(`⚠️ Run ${runId} failed persisting trace event`, {
            step_id: step.id,
            kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const queueTraceEvent = (
        kind: TraceEventKind,
        payload?: unknown,
        options?: {
          turn?: number | null;
          traceStatus?: StepTraceStatus;
        },
      ) => {
        traceWriteChain = traceWriteChain.then(() =>
          appendTraceEvent(kind, payload, options),
        );
        return traceWriteChain;
      };

      await queueTraceEvent("step.started", {
        step_id: step.id,
        step_index: i,
        type: step.type || "llm",
        model: step.model || "gpt-5.2",
      });

      try {
        const prompt = step.prompt ? interpolate(step.prompt, context) : "";
        const stepType = step.type || "llm";
        const startTime = Date.now();

        let rawOutput = "";
        let parsedOutput: unknown;
        let inputTokens = 0;
        let outputTokens = 0;
        let costCents = 0;
        let modelCostCents = 0;
        let toolCostCents = 0;
        let toolCallsTotal = 0;
        let toolCallsSuccess = 0;
        let toolCallsFailed = 0;
        let agentTrace: unknown = null;

        if (stepType === "llm") {
          const systemPrompt = step.system_prompt
            ? interpolate(step.system_prompt, context)
            : undefined;
          const stepAgent = resolveStepAgentConfig(
            definition,
            step as Record<string, unknown>,
            userPlan,
          );
          const apiKeys =
            fundingMode === "app_credits"
              ? platformApiKeys
              : {
                  openai:
                    envSecrets.values.OPENAI_API_KEY ||
                    envSecrets.values.openai_api_key,
                  anthropic:
                    envSecrets.values.ANTHROPIC_API_KEY ||
                    envSecrets.values.anthropic_api_key,
                  gemini:
                    envSecrets.values.GEMINI_API_KEY ||
                    envSecrets.values.GOOGLE_API_KEY ||
                    envSecrets.values.gemini_api_key ||
                    envSecrets.values.google_api_key,
                  mistral:
                    envSecrets.values.MISTRAL_API_KEY ||
                    envSecrets.values.mistral_api_key,
                  zai:
                    envSecrets.values.ZAI_API_KEY ||
                    envSecrets.values.zai_api_key,
                };

          try {
            console.log(`🤖 Run ${runId} invoking agent runtime`, {
              step_id: step.id,
              model: step.model || "gpt-5.2",
              max_turns: stepAgent.max_turns,
              max_duration_seconds: stepAgent.max_duration_seconds,
              max_tool_calls: stepAgent.max_tool_calls,
              tools: stepAgent.tools.length,
            });
            const result = await runAgentRuntime({
              model: step.model || "gpt-5.2",
              prompt,
              system: systemPrompt,
              temperature: step.temperature,
              max_tokens: step.max_tokens,
              output_format: step.output_format,
              api_keys: apiKeys,
              agent: stepAgent,
              debug_label: `${runId}:${step.id}`,
              on_log: (entry) => {
                const sanitized = sanitizeAgentLogEntry(
                  entry,
                  envSecrets.plainValues,
                );
                agentLogs.push(sanitized);
                const traceKind = traceEventKindFromAgentLog(sanitized);
                if (traceKind) {
                  void queueTraceEvent(
                    traceKind,
                    tracePayloadFromAgentLog(sanitized),
                    {
                      turn: traceTurnFromAgentLog(sanitized),
                      traceStatus:
                        traceKind === "agent.failed" ? "failed" : "streaming",
                    },
                  );
                }
                void maybePersistAgentLogs(false);
              },
            });
            rawOutput = result.output;
            parsedOutput = result.output;
            inputTokens = result.input_tokens;
            outputTokens = result.output_tokens;
            toolCallsTotal = result.tool_calls_total;
            toolCallsSuccess = result.tool_calls_success;
            toolCallsFailed = result.tool_calls_failed;
            agentTrace = result.trace;
            for (const traceEvent of extractTurnTraceEvents(
              result.trace,
              envSecrets.plainValues,
            )) {
              await queueTraceEvent(traceEvent.kind, traceEvent.payload, {
                turn: traceEvent.turn ?? null,
              });
            }
            console.log(`🤖 Run ${runId} agent runtime completed`, {
              step_id: step.id,
              turns_used: result.turns_used,
              tool_calls_total: result.tool_calls_total,
              total_tokens: result.total_tokens,
            });
          } catch (agentErr) {
            const toolActivityDetected = hasToolActivity(agentLogs);
            const shouldFailStepWithoutFallback =
              toolActivityDetected || isTimeoutLikeError(agentErr);
            if (shouldFailStepWithoutFallback) {
              const salvagedToolResult =
                extractLastSuccessfulToolResult(agentLogs);
              if (salvagedToolResult != null) {
                rawOutput =
                  typeof salvagedToolResult === "string"
                    ? salvagedToolResult
                    : JSON.stringify(salvagedToolResult);
                parsedOutput = salvagedToolResult;
                toolCallsSuccess = Math.max(toolCallsSuccess, 1);
                toolCallsTotal = Math.max(toolCallsTotal, 1);
                console.warn(
                  `⚠️ Agent runtime failed for step ${step.id}; salvaging last successful tool result`,
                  agentErr,
                );
              } else {
                const reason = toolActivityDetected
                  ? "tool activity already occurred"
                  : "agent runtime timeout/deadline exceeded";
                console.warn(
                  `⚠️ Agent runtime failed for step ${step.id}; not using direct-model fallback (${reason})`,
                  agentErr,
                );
                throw agentErr;
              }
            } else {
              console.warn(
                `⚠️ Agent runtime failed for step ${step.id}, falling back to direct model call`,
                agentErr,
              );
              await queueTraceEvent("fallback.started", {
                reason:
                  agentErr instanceof Error
                    ? agentErr.message
                    : String(agentErr),
              });
              const result = await callModel({
                model: step.model || "gpt-5.2",
                prompt,
                system: systemPrompt,
                temperature: step.temperature,
                max_tokens: step.max_tokens,
                output_format: step.output_format,
                api_keys: apiKeys,
              });
              rawOutput = result.output;
              parsedOutput = result.output;
              inputTokens = result.input_tokens;
              outputTokens = result.output_tokens;
              modelCostCents = result.cost_cents;
              await queueTraceEvent("fallback.completed", {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cost_cents: modelCostCents,
              });
              console.log(`🪂 Run ${runId} fallback model call completed`, {
                step_id: step.id,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              });
            }
          }

          if (modelCostCents <= 0) {
            modelCostCents = calculateModelCostCents(
              step.model || "gpt-5.2",
              inputTokens,
              outputTokens,
            );
          }
          const toolFee = getPlanNumericLimit(
            userPlan,
            "agent_tool_fee_cents",
            0,
          );
          toolCostCents = toolCallsSuccess * toolFee;
          costCents = modelCostCents + toolCostCents;

          if (step.output_format === "json") {
            try {
              parsedOutput = JSON.parse(rawOutput);
            } catch {
              parsedOutput = rawOutput;
            }
          }
        } else if (stepType === "transform") {
          rawOutput = prompt;
          parsedOutput = prompt;
        } else {
          throw new Error(`Step type "${stepType}" is not implemented`);
        }

        const durationMs = Date.now() - startTime;
        const stepContext = context.steps as Record<
          string,
          { output: unknown }
        >;
        stepContext[step.id] = { output: parsedOutput };
        if (!(String(i) in stepContext))
          stepContext[String(i)] = { output: parsedOutput };
        if (!(String(i + 1) in stepContext)) {
          stepContext[String(i + 1)] = { output: parsedOutput };
        }

        totalTokens += inputTokens + outputTokens;
        totalCostCents += costCents;
        totalModelCostCents += modelCostCents;
        totalToolCostCents += toolCostCents;
        totalToolCalls += toolCallsTotal;
        await maybePersistAgentLogs(true);
        await traceWriteChain;
        await queueTraceEvent(
          "step.completed",
          {
            duration_ms: durationMs,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_cost_cents: costCents,
            tool_calls_total: toolCallsTotal,
          },
          { traceStatus: "completed" },
        );
        await traceWriteChain;

        await db
          .update(stepExecutions)
          .set({
            status: "completed",
            promptSent: redactSecrets(prompt, envSecrets.plainValues),
            rawOutput,
            parsedOutput,
            inputTokens,
            outputTokens,
            costCents,
            modelCostCents,
            toolCostCents,
            toolCallsTotal,
            toolCallsSuccess,
            toolCallsFailed,
            traceEventCount: stepTraceSeq,
            latestTraceSeq: stepTraceSeq,
            traceStatus: "completed",
            agentTrace,
            agentLogs,
            durationMs,
            completedAt: new Date(),
          } as Record<string, unknown>)
          .where(eq(stepExecutions.id, stepExec.id));
        console.log(`✅ Run ${runId} step completed`, {
          step_id: step.id,
          duration_ms: durationMs,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          model_cost_cents: modelCostCents,
          tool_cost_cents: toolCostCents,
          total_cost_cents: costCents,
        });
      } catch (stepErr) {
        const rawError =
          stepErr instanceof Error ? stepErr.message : String(stepErr);
        const error = redactSecrets(rawError, envSecrets.plainValues);
        await maybePersistAgentLogs(true);
        await traceWriteChain;
        await queueTraceEvent(
          "step.failed",
          { error },
          { traceStatus: "failed" },
        );
        await traceWriteChain;

        await db
          .update(stepExecutions)
          .set({
            status: "failed",
            error,
            traceEventCount: stepTraceSeq,
            latestTraceSeq: stepTraceSeq,
            traceStatus: "failed",
            agentLogs,
            completedAt: new Date(),
          } as Record<string, unknown>)
          .where(eq(stepExecutions.id, stepExec.id));

        throw new Error(`Step "${step.id}" failed: ${error}`);
      }
    }

    const outputStepId =
      definition.output?.from ||
      definition.steps[definition.steps.length - 1].id;
    const outputData = (context.steps as Record<string, { output: unknown }>)[
      outputStepId
    ]?.output;
    const completedAt = new Date();

    await db
      .update(runs)
      .set({
        status: "completed",
        outputData: outputData === undefined ? null : outputData,
        totalTokens,
        totalCostCents,
        modelCostCents: totalModelCostCents,
        toolCostCents: totalToolCostCents,
        toolCallsTotal: totalToolCalls,
        completedAt,
      } as Record<string, unknown>)
      .where(eq(runs.id, runId));
    console.log(`🏁 Run ${runId} completed`, {
      total_tokens: totalTokens,
      model_cost_cents: totalModelCostCents,
      tool_cost_cents: totalToolCostCents,
      total_cost_cents: totalCostCents,
      tool_calls_total: totalToolCalls,
      duration_ms: Date.now() - runStartMs,
    });

    serverTrack(run.userId, "pipeline_run_completed", {
      run_id: runId,
      pipeline_id: run.pipelineId,
      total_tokens: totalTokens,
      total_cost_cents: totalCostCents,
      step_count: definition.steps.length,
      duration_ms:
        completedAt.getTime() -
        (runStartedAt?.getTime() ?? completedAt.getTime()),
    });

    await deductRunCredits(
      run.id,
      run.userId,
      totalTokens,
      totalCostCents,
      totalToolCostCents,
      fundingMode,
    );
    creditsDeducted = true;

    await deliverOutputWebhooks({
      definition,
      run,
      runId,
      runStartedAt,
      completedAt,
      inputData: (run.inputData || {}) as Record<string, unknown>,
      outputData,
      envValues: envSecrets.values,
    });
    // TODO: Deduct credits from user
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    const error = redactSecrets(rawError, envSecrets.plainValues);
    console.error(`❌ Run ${runId} failed before completion: ${error}`);
    serverTrack(run.userId, "pipeline_run_failed", {
      run_id: runId,
      pipeline_id: run.pipelineId,
      error,
      total_tokens: totalTokens,
      total_cost_cents: totalCostCents,
    });
    await db
      .update(runs)
      .set({
        status: "failed",
        error,
        completedAt: new Date(),
        totalTokens,
        totalCostCents,
        modelCostCents: totalModelCostCents,
        toolCostCents: totalToolCostCents,
        toolCallsTotal: totalToolCalls,
      } as Record<string, unknown>)
      .where(eq(runs.id, runId));

    if (!creditsDeducted) {
      await deductRunCredits(
        run.id,
        run.userId,
        totalTokens,
        totalCostCents,
        totalToolCostCents,
        fundingMode,
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function creditsFromTokens(totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  return Math.ceil(totalTokens / TOKENS_PER_CREDIT);
}

function creditsFromToolFees(plan: Plan, toolCostCents: number): number {
  if (toolCostCents <= 0) return 0;
  const creditValue = getPlanNumericLimit(plan, "credit_value_cents", 1);
  if (creditValue <= 0) return 0;
  return Math.ceil(toolCostCents / creditValue);
}

function getPlanNumericLimit(
  plan: Plan,
  key: string,
  fallback: number,
): number {
  const limits = PLAN_LIMITS[plan] as unknown as Record<string, unknown>;
  const value = limits[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function calculateModelCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const normalized = model.trim().toLowerCase();
  const modelInfo = SUPPORTED_MODELS.find(
    (item) => item.id.toLowerCase() === normalized,
  );
  if (!modelInfo) return 0;
  const inputCost =
    (inputTokens / 1_000_000) * modelInfo.input_cost_per_million;
  const outputCost =
    (outputTokens / 1_000_000) * modelInfo.output_cost_per_million;
  const withMarkup = (inputCost + outputCost) * (1 + MARKUP_PERCENTAGE / 100);
  return Math.ceil(withMarkup);
}

function resolveStepAgentConfig(
  definition: PipelineDefinition,
  step: Record<string, unknown>,
  plan: Plan,
) {
  const defaults = (definition as Record<string, unknown>).agent_defaults as
    | Record<string, unknown>
    | undefined;
  const perStep = step.agent as Record<string, unknown> | undefined;

  const capTurns = getPlanNumericLimit(plan, "agent_max_turns", 8);
  const capDuration = getPlanNumericLimit(
    plan,
    "agent_max_duration_seconds",
    120,
  );
  const capTools = getPlanNumericLimit(plan, "agent_max_tool_calls", 3);

  const maxTurns = Number(
    perStep?.max_turns ?? defaults?.max_turns ?? capTurns,
  );
  const maxDuration = capDuration;
  const maxToolCalls = Number(
    perStep?.max_tool_calls ?? defaults?.max_tool_calls ?? capTools,
  );

  if (perStep?.allow_parallel_tools === true || defaults?.allow_parallel_tools === true) {
    throw new Error("allow_parallel_tools is not supported in this runtime");
  }

  const toolsRaw = (perStep?.tools ?? defaults?.tools ?? []) as Array<
    Record<string, unknown>
  >;
  const unsupportedToolTypes = toolsRaw
    .map((item) => String(item?.type || "http_request"))
    .filter(
      (type) =>
        !SAFE_AGENT_TOOL_TYPES.includes(
          type as (typeof SAFE_AGENT_TOOL_TYPES)[number],
        ),
    );
  if (unsupportedToolTypes.length > 0) {
    throw new Error(
      `Unsupported agent tool types: ${Array.from(new Set(unsupportedToolTypes)).join(", ")}`,
    );
  }
  const tools = toolsRaw
    .filter((item) => item && typeof item.name === "string")
    .map((item) => ({
      type: String(item.type || "http_request") as
        | "http_request"
        | "extract_json"
        | "template_render"
        | "curl",
      name: String(item.name),
      description:
        typeof item.description === "string" ? item.description : undefined,
      input_schema:
        item.input_schema && typeof item.input_schema === "object"
          ? (item.input_schema as Record<string, unknown>)
          : undefined,
      js_source:
        typeof item.js_source === "string" ? item.js_source : undefined,
    }))
    .map(applyDefaultSchema);

  const networkAllowlistRaw = (perStep?.network_allowlist ??
    defaults?.network_allowlist ??
    []) as unknown[];
  const networkAllowlist = networkAllowlistRaw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    max_turns: Math.max(1, Math.min(maxTurns, capTurns)),
    max_duration_seconds: Math.max(1, Math.min(maxDuration, capDuration)),
    max_tool_calls: Math.max(0, Math.min(maxToolCalls, capTools)),
    allow_parallel_tools: false,
    tools,
    network_allowlist: networkAllowlist,
  };
}

async function deductRunCredits(
  runId: string,
  userId: string,
  totalTokens: number,
  totalCostCents: number,
  toolCostCents: number,
  fundingMode: RunFundingMode,
) {
  if (fundingMode === "byok_required") {
    await db.update(runs).set({ creditsDeducted: 0 }).where(eq(runs.id, runId));
    return;
  }

  const [user] = await db
    .select({ plan: users.plan, creditsRemaining: users.creditsRemaining })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return;

  const plan = (user.plan in PLAN_LIMITS ? user.plan : "free") as Plan;
  let creditsToDeduct =
    creditsFromTokens(totalTokens) + creditsFromToolFees(plan, toolCostCents);
  if (fundingMode === "app_credits" && (plan === "starter" || plan === "pro")) {
    const rate = PLAN_LIMITS[plan].overage_per_credit_cents;
    creditsToDeduct =
      totalCostCents > 0 && rate > 0 ? Math.ceil(totalCostCents / rate) : 0;
  }
  if (creditsToDeduct <= 0) {
    await db.update(runs).set({ creditsDeducted: 0 }).where(eq(runs.id, runId));
    return;
  }

  const nextCredits = Math.max(0, user.creditsRemaining - creditsToDeduct);
  await db
    .update(users)
    .set({ creditsRemaining: nextCredits, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await db
    .update(runs)
    .set({ creditsDeducted: creditsToDeduct })
    .where(eq(runs.id, runId));
}

function interpolate(
  template: string,
  context: Record<string, unknown>,
): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(context);
}

async function resolveUserSecrets(
  userId: string,
  pipelineId: string,
  definition: PipelineDefinition,
  database: typeof db,
  additionalNames: string[] = [],
  options?: {
    includeProviderSecrets?: boolean;
  },
): Promise<{ values: Record<string, string>; plainValues: string[] }> {
  const includeProviderSecrets = options?.includeProviderSecrets ?? true;
  const providerNames = includeProviderSecrets
    ? [
        ...providerSecretNames("openai"),
        ...providerSecretNames("anthropic"),
        ...providerSecretNames("google"),
        ...providerSecretNames("mistral"),
        ...providerSecretNames("zai"),
      ]
    : [];

  const allText = definition.steps
    .map((s) => `${s.prompt || ""} ${s.system_prompt || ""}`)
    .join(" ");
  const refs = allText.match(/\{\{env\.(\w+)\}\}/g);
  const referencedNames = refs
    ? refs.map((r) => r.match(/\{\{env\.(\w+)\}\}/)?.[1]).filter(Boolean)
    : [];
  const names = [
    ...new Set([...providerNames, ...referencedNames, ...additionalNames]),
  ] as string[];
  if (names.length === 0) return { values: {}, plainValues: [] };

  let secrets: Array<{
    name: string;
    pipelineId: string | null;
    encryptedValue: string;
  }> = [];
  try {
    secrets = await database
      .select({
        name: userSecrets.name,
        pipelineId: userSecrets.pipelineId,
        encryptedValue: userSecrets.encryptedValue,
      })
      .from(userSecrets)
      .where(
        and(eq(userSecrets.userId, userId), inArray(userSecrets.name, names)),
      );
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    const legacySecrets = await database
      .select({
        name: userSecrets.name,
        encryptedValue: userSecrets.encryptedValue,
      })
      .from(userSecrets)
      .where(
        and(eq(userSecrets.userId, userId), inArray(userSecrets.name, names)),
      );
    secrets = legacySecrets.map((secret) => ({
      ...secret,
      pipelineId: null,
    }));
  }

  if (secrets.length === 0) return { values: {}, plainValues: [] };

  const scopedSecrets = secrets.filter(
    (secret) => secret.pipelineId === pipelineId || secret.pipelineId == null,
  );
  if (scopedSecrets.length === 0) return { values: {}, plainValues: [] };

  let masterKey: Buffer;
  try {
    masterKey = await createKmsProvider().getMasterKey();
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(
      `Worker cannot decrypt secrets: configure STEPIQ_MASTER_KEY or Vault KMS${reason}`,
    );
  }

  const values: Record<string, string> = {};
  const plainValues: string[] = [];

  const sortedSecrets = [...scopedSecrets].sort((a, b) => {
    const aPipeline = (a as { pipelineId?: string | null }).pipelineId;
    const bPipeline = (b as { pipelineId?: string | null }).pipelineId;
    if (aPipeline && !bPipeline) return 1;
    if (!aPipeline && bPipeline) return -1;
    return 0;
  });

  for (const secret of sortedSecrets) {
    const blob = Buffer.from(secret.encryptedValue, "base64");
    const plaintext = await decryptSecret(userId, blob, masterKey);
    values[secret.name] = plaintext;
    plainValues.push(plaintext);
  }

  return { values, plainValues };
}

function getOutputSigningSecretNames(definition: PipelineDefinition): string[] {
  return (definition.output?.deliver || [])
    .filter((delivery) => delivery.type === "webhook")
    .map((delivery) => {
      const raw = (delivery as Record<string, unknown>).signing_secret_name;
      return typeof raw === "string" ? raw : undefined;
    })
    .filter((name): name is string => Boolean(name));
}

async function deliverOutputWebhooks(params: {
  definition: PipelineDefinition;
  run: {
    pipelineId: string;
    pipelineVersion: number;
    triggerType: string;
  };
  runId: string;
  runStartedAt: Date;
  completedAt: Date;
  inputData: Record<string, unknown>;
  outputData: unknown;
  envValues: Record<string, string>;
}) {
  const targets = (params.definition.output?.deliver || []).filter(
    (delivery) => delivery.type === "webhook" && delivery.url,
  );
  for (const target of targets) {
    const rawSecretName = (target as Record<string, unknown>)
      .signing_secret_name;
    const secretName =
      typeof rawSecretName === "string" ? rawSecretName : undefined;
    const signingSecret = secretName ? params.envValues[secretName] : undefined;
    if (secretName && !signingSecret) {
      console.warn(
        `⚠️ Run ${params.runId}: webhook ${target.url} signing secret "${secretName}" not found; sending unsigned`,
      );
    }

    const attempts = await deliverWebhookWithRetry({
      url: target.url as string,
      method: target.method,
      signingSecret,
      envelope: {
        event: "pipeline.run.completed",
        pipeline: {
          id: params.run.pipelineId,
          version: params.run.pipelineVersion,
          name: params.definition.name,
        },
        run: {
          id: params.runId,
          status: "completed",
          trigger_type: params.run.triggerType,
          started_at: params.runStartedAt.toISOString(),
          completed_at: params.completedAt.toISOString(),
        },
        input: params.inputData,
        output: params.outputData,
      },
    });

    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt?.ok) {
      console.log(
        `✅ Run ${params.runId}: delivered webhook ${target.url} in ${attempts.length} attempt(s)`,
      );
    } else {
      console.error(
        `❌ Run ${params.runId}: failed webhook delivery to ${target.url}`,
        attempts,
      );
    }
  }
}
