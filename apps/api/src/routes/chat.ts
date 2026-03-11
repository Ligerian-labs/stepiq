import {
  createKmsProvider,
  decryptSecret,
  pipelineDefinitionSchema,
  providerForModel,
  providerSecretNames,
  type PipelineDefinition,
} from "@stepiq/core";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  chatMessages,
  chatSessions,
  pipelineVersions,
  pipelineTemplates,
  pipelines,
  runs,
  schedules,
  stepExecutions,
  userSecrets,
  users,
} from "../db/schema.js";
import type { Env } from "../lib/env.js";
import { requireAuth } from "../middleware/auth.js";
import {
  sanitizeUserInput,
  validateUserInput,
} from "../services/chat-security.js";
import {
  handleChatMessage,
  type ChatProviderKeys,
} from "../services/chat.js";
import { validateInputAgainstPipelineSchema } from "../services/input-schema.js";
import { validatePipelineSecurity } from "../services/pipeline-security.js";
import {
  assertCanCreatePipeline,
  assertPipelineDefinitionWithinPlan,
  isPlanValidationError,
} from "../services/plan-validator.js";
import { enqueueRun } from "../services/queue.js";
import {
  checkRateLimit,
  getUserSecurityContext,
  logSecurityEvent,
} from "../services/security-monitor.js";

export const chatRoutes = new Hono<{ Variables: Env }>();

chatRoutes.use("*", requireAuth);

let kmsProvider: ReturnType<typeof createKmsProvider> | null = null;
function getKms() {
  if (!kmsProvider) kmsProvider = createKmsProvider();
  return kmsProvider;
}

function isMissingPipelineIdColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:no such column|column .* does not exist).*pipeline_id/i.test(
    error.message,
  );
}

async function resolveChatProviderKeys(params: {
  userId: string;
  pipelineId: string | null;
  modelId: string;
}): Promise<ChatProviderKeys> {
  const provider = providerForModel(params.modelId);
  if (!provider) return {};

  const candidateNames = providerSecretNames(provider);
  if (candidateNames.length === 0) return {};

  let secrets: Array<{
    name: string;
    pipelineId: string | null;
    encryptedValue: string;
  }> = [];

  try {
    secrets = await db
      .select({
        name: userSecrets.name,
        pipelineId: userSecrets.pipelineId,
        encryptedValue: userSecrets.encryptedValue,
      })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, params.userId),
          inArray(userSecrets.name, candidateNames),
        ),
      );
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    const legacySecrets = await db
      .select({
        name: userSecrets.name,
        encryptedValue: userSecrets.encryptedValue,
      })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, params.userId),
          inArray(userSecrets.name, candidateNames),
        ),
      );
    secrets = legacySecrets.map((secret) => ({ ...secret, pipelineId: null }));
  }

  if (secrets.length === 0) return {};

  const scopedSecrets = secrets.filter(
    (secret) =>
      secret.pipelineId == null || secret.pipelineId === params.pipelineId,
  );
  if (scopedSecrets.length === 0) return {};

  const sortedSecrets = [...scopedSecrets].sort((a, b) => {
    if (a.pipelineId && !b.pipelineId) return 1;
    if (!a.pipelineId && b.pipelineId) return -1;
    return 0;
  });

  let masterKey: Buffer;
  try {
    masterKey = await getKms().getMasterKey();
  } catch (error) {
    const reason =
      error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new Error(
      `Cannot decrypt saved secrets: configure STEPIQ_MASTER_KEY or Vault KMS${reason}`,
    );
  }

  let resolvedKey: string | null = null;
  for (const secret of sortedSecrets) {
    const blob = Buffer.from(secret.encryptedValue, "base64");
    resolvedKey = await decryptSecret(params.userId, blob, masterKey);
  }

  if (!resolvedKey) return {};

  if (provider === "openai") return { openai: resolvedKey };
  if (provider === "anthropic") return { anthropic: resolvedKey };
  if (provider === "google") return { google: resolvedKey, gemini: resolvedKey };
  if (provider === "mistral") return { mistral: resolvedKey };
  if (provider === "zai") return { zai: resolvedKey };
  return {};
}

const createSessionSchema = z.object({
  modelId: z.string().min(1),
  pipelineId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  requestId: z.string().uuid().optional(),
  action: z.enum(["create", "edit", "run", "test", "explain"]).optional(),
});

const applyPipelineSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const runPipelineSchema = z.object({
  input_data: z.record(z.unknown()).optional(),
});

const CANCEL_WINDOW_MS = 60_000;
const FOLLOWUP_MESSAGE_RE = /^(do this|go ahead|yes do it|apply this|proceed)$/i;
const UUID_RE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const MAX_RESOURCES_FROM_URLS = 5;
const MAX_CONTEXT_CHARS = 12_000;
type InFlightState = "running" | "canceled" | "completed";
const inFlightMessageRequests = new Map<
  string,
  { controller: AbortController; state: InFlightState; touchedAt: number }
>();

function inFlightKey(userId: string, sessionId: string, requestId: string): string {
  return `${userId}:${sessionId}:${requestId}`;
}

function pruneInFlightRequests() {
  const now = Date.now();
  for (const [key, value] of inFlightMessageRequests.entries()) {
    if (now - value.touchedAt > CANCEL_WINDOW_MS) {
      inFlightMessageRequests.delete(key);
    }
  }
}

function resolveEffectiveUserMessage(
  content: string,
  messages: Array<{ role: string; content: string }>,
): string {
  const trimmed = content.trim();
  if (!FOLLOWUP_MESSAGE_RE.test(trimmed)) return content;

  const lastActionableUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim().length > 0);

  if (!lastActionableUserMessage) return content;

  return `${trimmed}\n\nUse this prior request as context and execute it directly:\n${lastActionableUserMessage.content}`;
}

type ResourceRefKind = "pipeline" | "run" | "schedule";
type ResourceRef = { kind: ResourceRefKind; id: string; source: string };

function collectInternalHosts(): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  const addFromUrl = (raw?: string) => {
    if (!raw) return;
    try {
      const url = new URL(raw);
      hosts.add(url.hostname.toLowerCase());
    } catch {
      // ignore malformed env urls
    }
  };
  addFromUrl(process.env.APP_URL);
  addFromUrl(process.env.API_URL);
  return hosts;
}

function extractResourceRefsFromPath(path: string, source: string): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const trimmed = path.trim();
  const mappings: Array<{ kind: ResourceRefKind; pattern: RegExp }> = [
    { kind: "pipeline", pattern: new RegExp(`^/pipelines/(${UUID_RE})/edit$`, "i") },
    { kind: "pipeline", pattern: new RegExp(`^/api/pipelines/(${UUID_RE})(?:/|$)`, "i") },
    { kind: "run", pattern: new RegExp(`^/runs/(${UUID_RE})(?:/|$)`, "i") },
    { kind: "run", pattern: new RegExp(`^/api/runs/(${UUID_RE})(?:/|$)`, "i") },
    { kind: "schedule", pattern: new RegExp(`^/schedules/(${UUID_RE})(?:/|$)`, "i") },
    { kind: "schedule", pattern: new RegExp(`^/api/schedules/(${UUID_RE})(?:/|$)`, "i") },
  ];
  for (const mapping of mappings) {
    const match = trimmed.match(mapping.pattern);
    if (!match?.[1]) continue;
    refs.push({ kind: mapping.kind, id: match[1], source });
  }
  return refs;
}

function extractInternalResourceRefs(text: string): ResourceRef[] {
  const refs: ResourceRef[] = [];
  const internalHosts = collectInternalHosts();
  const tokenRegex = /(https?:\/\/[^\s)]+|\/(?:api\/)?(?:pipelines|runs|schedules)\/[^\s)]+)/gi;
  const tokens = text.match(tokenRegex) || [];

  for (const token of tokens) {
    if (token.startsWith("/")) {
      refs.push(...extractResourceRefsFromPath(token, token));
      continue;
    }

    try {
      const url = new URL(token);
      if (!internalHosts.has(url.hostname.toLowerCase())) continue;
      const path = url.pathname;
      refs.push(...extractResourceRefsFromPath(path, token));
    } catch {
      // ignore malformed urls
    }
  }

  const deduped = new Map<string, ResourceRef>();
  for (const ref of refs) {
    deduped.set(`${ref.kind}:${ref.id}`, ref);
  }
  return Array.from(deduped.values()).slice(0, MAX_RESOURCES_FROM_URLS);
}

async function fetchInternalResourceContext(
  userId: string,
  refs: ResourceRef[],
): Promise<string> {
  if (!refs.length) return "";

  const payload: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    if (ref.kind === "pipeline") {
      const [pipeline] = await db
        .select({
          id: pipelines.id,
          name: pipelines.name,
          description: pipelines.description,
          version: pipelines.version,
          status: pipelines.status,
          definition: pipelines.definition,
          updatedAt: pipelines.updatedAt,
        })
        .from(pipelines)
        .where(and(eq(pipelines.id, ref.id), eq(pipelines.userId, userId)))
        .limit(1);
      if (pipeline) {
        payload.push({ resource: "pipeline", source: ref.source, data: pipeline });
      }
      continue;
    }

    if (ref.kind === "run") {
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, ref.id), eq(runs.userId, userId)))
        .limit(1);
      if (!run) continue;

      const steps = await db
        .select({
          stepId: stepExecutions.stepId,
          status: stepExecutions.status,
          error: stepExecutions.error,
          parsedOutput: stepExecutions.parsedOutput,
          startedAt: stepExecutions.startedAt,
          completedAt: stepExecutions.completedAt,
        })
        .from(stepExecutions)
        .where(eq(stepExecutions.runId, run.id))
        .orderBy(stepExecutions.stepIndex);

      payload.push({
        resource: "run",
        source: ref.source,
        data: { ...run, stepExecutions: steps },
      });
      continue;
    }

    if (ref.kind === "schedule") {
      const [schedule] = await db
        .select({
          id: schedules.id,
          pipelineId: schedules.pipelineId,
          name: schedules.name,
          description: schedules.description,
          cronExpression: schedules.cronExpression,
          timezone: schedules.timezone,
          inputData: schedules.inputData,
          enabled: schedules.enabled,
          nextRunAt: schedules.nextRunAt,
          lastRunAt: schedules.lastRunAt,
        })
        .from(schedules)
        .innerJoin(pipelines, eq(schedules.pipelineId, pipelines.id))
        .where(and(eq(schedules.id, ref.id), eq(pipelines.userId, userId)))
        .limit(1);
      if (schedule) {
        payload.push({ resource: "schedule", source: ref.source, data: schedule });
      }
    }
  }

  if (!payload.length) return "";
  const serialized = JSON.stringify(payload, null, 2);
  const clipped =
    serialized.length > MAX_CONTEXT_CHARS
      ? `${serialized.slice(0, MAX_CONTEXT_CHARS)}\n... [truncated]`
      : serialized;
  return `INTERNAL_RESOURCE_CONTEXT (resolved from internal URLs in user message):\n${clipped}`;
}

function shouldAutoPersistPipeline(
  action: "create" | "edit" | "run" | "test" | "explain" | undefined,
  content: string,
): boolean {
  if (action === "create") return true;
  if (action === "edit") return true;
  return /\b(create|build|make|generate|set up|setup|update|edit|modify|change|revise)\b[\s\S]{0,80}\bpipeline\b/i.test(
    content,
  );
}

function coerceVariableType(value: unknown): "string" | "integer" | "boolean" | "number" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "string";
}

function normalizePromptVariables(template: string): string {
  return template.replace(/\{\{\s*variables\./g, "{{vars.");
}

function inferAgentToolsFromPrompt(prompt: string): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (/\bfetch_page\b/i.test(prompt)) {
    tools.push({
      type: "http_request",
      name: "fetch_page",
      description: "Fetch a URL over HTTP(S)",
    });
  }
  if (/\bfetch_fallback\b/i.test(prompt)) {
    tools.push({
      type: "curl",
      name: "fetch_fallback",
      description: "Fallback fetch using curl command",
    });
  }
  return tools;
}

function normalizeGeneratedPipelineDefinition(
  raw: unknown,
): PipelineDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const agentDefaultsRaw =
    source.agent_defaults && typeof source.agent_defaults === "object"
      ? source.agent_defaults
      : source.agentDefaults && typeof source.agentDefaults === "object"
        ? source.agentDefaults
        : undefined;

  const normalizedVariables: Record<string, string | number | boolean> = {};
  const varsRaw = source.variables;
  if (varsRaw && typeof varsRaw === "object" && !Array.isArray(varsRaw)) {
    for (const [key, value] of Object.entries(varsRaw)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        normalizedVariables[key] = value;
      } else if (value != null) {
        normalizedVariables[key] = JSON.stringify(value);
      }
    }
  }

  const inputSchemaRaw = source.input_schema as
    | {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      }
    | undefined;
  const inputRaw = source.input as
    | { schema?: Record<string, Record<string, unknown>> }
    | undefined;
  const inputSchemaSource =
    inputRaw?.schema || inputSchemaRaw?.properties || undefined;
  const requiredSet = new Set(inputSchemaRaw?.required || []);
  const normalizedInputSchema: Record<
    string,
    {
      type: "string" | "integer" | "boolean" | "number";
      description?: string;
      required?: boolean;
      default?: unknown;
    }
  > = {};
  if (inputSchemaSource && typeof inputSchemaSource === "object") {
    for (const [field, spec] of Object.entries(inputSchemaSource)) {
      const rawType =
        typeof spec?.type === "string"
          ? spec.type
          : coerceVariableType(spec?.default);
      const type: "string" | "integer" | "boolean" | "number" =
        rawType === "integer" ||
        rawType === "number" ||
        rawType === "boolean"
          ? rawType
          : "string";

      normalizedInputSchema[field] = {
        type,
        ...(typeof spec?.description === "string"
          ? { description: spec.description }
          : {}),
        ...(requiredSet.has(field) || spec?.required === true
          ? { required: true }
          : {}),
        ...(spec && Object.prototype.hasOwnProperty.call(spec, "default")
          ? { default: spec.default }
          : {}),
      };
    }
  }

  const sourceSteps = Array.isArray(source.steps)
    ? source.steps
    : ([] as unknown[]);
  const normalizedSteps = sourceSteps.map((entry, index) => {
    const step = (entry || {}) as Record<string, unknown>;
    const rawType =
      typeof step.type === "string" ? step.type.toLowerCase() : "llm";
    const type = rawType === "llm" || rawType === "transform" ? rawType : "llm";
    const id =
      typeof step.id === "string" && /^[a-z0-9_]+$/.test(step.id)
        ? step.id
        : `step_${index + 1}`;
    const name =
      typeof step.name === "string" && step.name.trim()
        ? step.name
        : `Step ${index + 1}`;

    let prompt =
      typeof step.prompt === "string" && step.prompt.trim()
        ? step.prompt
        : undefined;
    let systemPrompt =
      typeof step.system_prompt === "string" && step.system_prompt.trim()
        ? step.system_prompt
        : typeof step.systemPrompt === "string" && step.systemPrompt.trim()
          ? step.systemPrompt
          : undefined;
    const agentConfig =
      type === "llm" && step.agent && typeof step.agent === "object"
        ? step.agent
        : undefined;

    if (!prompt && typeof step.instructions === "string" && step.instructions.trim()) {
      prompt = step.instructions;
    }
    if (!prompt && typeof step.url === "string" && step.url.trim()) {
      prompt = `Fetch data from ${step.url} and produce structured output.`;
    }
    if (!prompt && Array.isArray(step.operations)) {
      prompt = `Apply transform operations:\n${JSON.stringify(step.operations)}`;
    }
    if (!prompt && typeof step.steps === "object") {
      prompt = `Execute nested step plan:\n${JSON.stringify(step.steps)}`;
    }
    if (!prompt) {
      prompt = "Process the available input and produce the step output.";
    }

    prompt = normalizePromptVariables(prompt);
    if (systemPrompt) {
      systemPrompt = normalizePromptVariables(systemPrompt);
    }
    const inferredTools = inferAgentToolsFromPrompt(prompt);
    const normalizedAgentConfig =
      type !== "llm"
        ? undefined
        : agentConfig && typeof agentConfig === "object"
          ? ({
              ...agentConfig,
              ...(Array.isArray((agentConfig as { tools?: unknown[] }).tools) &&
              ((agentConfig as { tools?: unknown[] }).tools?.length ?? 0) > 0
                ? {}
                : inferredTools.length > 0
                  ? { tools: inferredTools }
                  : {}),
            } as Record<string, unknown>)
          : inferredTools.length > 0
            ? ({
                max_turns: 6,
                max_duration_seconds: 45,
                max_tool_calls: 3,
                allow_parallel_tools: false,
                tools: inferredTools,
              } as Record<string, unknown>)
            : undefined;

    const timeoutSeconds =
      typeof step.timeout_seconds === "number"
        ? step.timeout_seconds
        : typeof step.timeout_ms === "number"
          ? Math.max(1, Math.round(step.timeout_ms / 1000))
          : 60;

    const retry =
      typeof step.retries === "number"
        ? { max_attempts: Math.max(1, Math.min(5, step.retries)), backoff_ms: 1000 }
        : step.retry &&
            typeof step.retry === "object" &&
            typeof (step.retry as { max_attempts?: unknown }).max_attempts ===
              "number"
          ? {
              max_attempts: Math.max(
                1,
                Math.min(5, (step.retry as { max_attempts: number }).max_attempts),
              ),
              backoff_ms:
                typeof (step.retry as { backoff_ms?: unknown }).backoff_ms ===
                "number"
                  ? (step.retry as { backoff_ms: number }).backoff_ms
                  : 1000,
            }
          : undefined;

    return {
      id,
      name,
      type,
      prompt,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      ...(type === "llm"
        ? {
            model:
              typeof step.model === "string" && step.model.trim()
                ? step.model
                : "gpt-5.2",
            output_format:
              step.output_format === "json" ||
              step.output_format === "text" ||
              step.output_format === "markdown"
                ? step.output_format
                : "text",
            ...(normalizedAgentConfig ? { agent: normalizedAgentConfig } : {}),
          }
        : {}),
      timeout_seconds: timeoutSeconds,
      ...(retry ? { retry } : {}),
    };
  });

  const outputRaw = (source.output || {}) as Record<string, unknown>;
  const outputFrom =
    (typeof outputRaw.from === "string" && outputRaw.from) ||
    (typeof outputRaw.from_step === "string" && outputRaw.from_step) ||
    (typeof outputRaw.fromStep === "string" && outputRaw.fromStep) ||
    normalizedSteps[normalizedSteps.length - 1]?.id;

  if (!normalizedSteps.length || !outputFrom) return null;

  return {
    name:
      typeof source.name === "string" && source.name.trim()
        ? source.name
        : "Generated Pipeline",
    ...(typeof source.description === "string" && source.description.trim()
      ? { description: source.description }
      : {}),
    version:
      typeof source.version === "number" && Number.isFinite(source.version)
        ? source.version
        : 1,
    ...(Object.keys(normalizedVariables).length
      ? { variables: normalizedVariables }
      : {}),
    ...(Object.keys(normalizedInputSchema).length
      ? { input: { schema: normalizedInputSchema } }
      : {}),
    ...(agentDefaultsRaw ? { agent_defaults: agentDefaultsRaw } : {}),
    steps: normalizedSteps as PipelineDefinition["steps"],
    output: { from: outputFrom },
  } as PipelineDefinition;
}

async function upsertPipelineFromChat(params: {
  userId: string;
  sessionId: string;
  existingPipelineId: string | null;
  definition: PipelineDefinition;
  suggestedName: string;
}): Promise<{ pipeline: typeof pipelines.$inferSelect; created: boolean }> {
  const creatingNewPipeline = !params.existingPipelineId;
  if (creatingNewPipeline) {
    const rateLimit = await checkRateLimit(params.userId, "pipeline_create");
    if (!rateLimit.allowed) {
      throw new Error("Pipeline creation rate limit exceeded");
    }
  }

  await assertCanCreatePipeline(params.userId);
  await assertPipelineDefinitionWithinPlan(params.userId, params.definition);

  const fallbackName =
    params.suggestedName.trim() ||
    params.definition.name ||
    "Generated Pipeline";

  if (params.existingPipelineId) {
    const [existing] = await db
      .select()
      .from(pipelines)
      .where(
        and(
          eq(pipelines.id, params.existingPipelineId),
          eq(pipelines.userId, params.userId),
        ),
      )
      .limit(1);

    if (existing) {
      const newVersion = existing.version + 1;
      const [updated] = await db
        .update(pipelines)
        .set({
          name: params.definition.name || existing.name || fallbackName,
          description:
            params.definition.description || existing.description || null,
          definition: params.definition,
          version: newVersion,
          updatedAt: new Date(),
        })
        .where(eq(pipelines.id, existing.id))
        .returning();

      await db.insert(pipelineVersions).values({
        pipelineId: updated.id,
        version: newVersion,
        definition: params.definition,
      });
      return { pipeline: updated, created: false };
    }
  }

  const [created] = await db
    .insert(pipelines)
    .values({
      userId: params.userId,
      name: params.definition.name || fallbackName,
      description: params.definition.description || null,
      definition: params.definition,
      status: "active",
    })
    .returning();

  await db.insert(pipelineVersions).values({
    pipelineId: created.id,
    version: created.version,
    definition: params.definition,
  });

  await db
    .update(chatSessions)
    .set({ pipelineId: created.id, updatedAt: new Date() })
    .where(eq(chatSessions.id, params.sessionId));

  return { pipeline: created, created: true };
}

chatRoutes.post("/sessions", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { modelId, pipelineId, title } = parsed.data;

  let initialPipelineState = null;
  if (pipelineId) {
    const [pipeline] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
      .limit(1);

    if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);
    initialPipelineState = pipeline.definition;
  }

  const [session] = await db
    .insert(chatSessions)
    .values({
      userId,
      modelId,
      pipelineId: pipelineId || null,
      title: title || "New Chat",
      pipelineVersion: 1,
      status: "active",
    })
    .returning();

  if (initialPipelineState) {
    await db.insert(chatMessages).values({
      sessionId: session.id,
      role: "system",
      content: "Pipeline loaded for editing",
      pipelineState: initialPipelineState,
      pipelineVersion: 1,
      action: "edit",
    });
  }

  return c.json(session, 201);
});

chatRoutes.get("/sessions", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const result = await db
    .select()
    .from(chatSessions)
    .where(
      and(eq(chatSessions.userId, userId), eq(chatSessions.status, "active")),
    )
    .orderBy(desc(chatSessions.updatedAt));

  return c.json(result);
});

chatRoutes.get("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);

  return c.json({ ...session, messages });
});

chatRoutes.delete("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");

  const [result] = await db
    .update(chatSessions)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .returning({ id: chatSessions.id });

  if (!result) return c.json({ error: "Session not found" }, 404);

  return c.json({ archived: true });
});

chatRoutes.post("/sessions/:id/messages/:requestId/cancel", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const requestId = c.req.param("requestId");
  pruneInFlightRequests();

  const key = inFlightKey(userId, sessionId, requestId);
  const entry = inFlightMessageRequests.get(key);
  if (!entry) return c.json({ canceled: false, error: "Request not found" }, 404);

  if (entry.state === "completed") {
    return c.json({ canceled: false, reason: "already_completed" }, 409);
  }

  entry.state = "canceled";
  entry.touchedAt = Date.now();
  entry.controller.abort();
  inFlightMessageRequests.set(key, entry);
  return c.json({ canceled: true, requestId });
});

chatRoutes.post("/sessions/:id/messages", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const rateLimit = await checkRateLimit(userId, "message");
  if (!rateLimit.allowed) {
    return c.json(
      {
        error: "Rate limit exceeded. Please wait before sending more messages.",
        resetAt: rateLimit.resetAt,
      },
      429,
    );
  }

  const inputCheck = validateUserInput(parsed.data.content);
  if (!inputCheck.safe) {
    await logSecurityEvent({
      type: "input_rejection",
      userId,
      sessionId,
      severity: inputCheck.severity,
      details: { patterns: inputCheck.patterns, reason: inputCheck.reason },
    });

    return c.json(
      {
        error:
          "Your request cannot be processed for security reasons. Please ensure your message is appropriate for pipeline building.",
      },
      400,
    );
  }

  const requestId = parsed.data.requestId || randomUUID();
  const sanitizedContent = sanitizeUserInput(parsed.data.content);

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  const messages = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);

  const effectiveUserMessage = resolveEffectiveUserMessage(
    sanitizedContent,
    messages.map((message) => ({
      role: String((message as { role?: unknown }).role || ""),
      content: String((message as { content?: unknown }).content || ""),
    })),
  );

  const internalRefs = extractInternalResourceRefs(sanitizedContent);
  const internalContextBlock = await fetchInternalResourceContext(
    userId,
    internalRefs,
  );
  const modelUserMessage = internalContextBlock
    ? `${effectiveUserMessage}\n\n${internalContextBlock}`
    : effectiveUserMessage;

  await db.insert(chatMessages).values({
    sessionId,
    role: "user",
    content: sanitizedContent,
    action: parsed.data.action,
  });

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const userContext = await getUserSecurityContext(userId, sessionId);

  pruneInFlightRequests();
  const key = inFlightKey(userId, sessionId, requestId);
  const controller = new AbortController();
  inFlightMessageRequests.set(key, {
    controller,
    state: "running",
    touchedAt: Date.now(),
  });

  let response: Awaited<ReturnType<typeof handleChatMessage>>;
  try {
    const providerKeys = await resolveChatProviderKeys({
      userId,
      pipelineId: session.pipelineId,
      modelId: session.modelId,
    });

    response = await handleChatMessage(
      session as Parameters<typeof handleChatMessage>[0],
      messages as Parameters<typeof handleChatMessage>[1],
      modelUserMessage,
      parsed.data.action,
      userContext,
      providerKeys,
      { abortSignal: controller.signal },
    );
  } catch (error) {
    const inFlight = inFlightMessageRequests.get(key);
    if (inFlight && inFlight.state === "canceled") {
      await db.insert(chatMessages).values({
        sessionId,
        role: "assistant",
        content: "Request canceled.",
        action: "explain",
      });
      inFlightMessageRequests.set(key, {
        ...inFlight,
        state: "completed",
        touchedAt: Date.now(),
      });
      return c.json({ canceled: true, requestId });
    }

    console.error("Builder chat model call failed", {
      sessionId,
      modelId: session.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    inFlightMessageRequests.set(key, {
      controller,
      state: "completed",
      touchedAt: Date.now(),
    });
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate assistant response",
        requestId,
      },
      502,
    );
  }

  if (response.pipelineState) {
    const mappedPipeline = normalizeGeneratedPipelineDefinition(
      response.pipelineState,
    );
    if (!mappedPipeline) {
      inFlightMessageRequests.set(key, {
        controller,
        state: "completed",
        touchedAt: Date.now(),
      });
      return c.json(
        {
          error: "Generated pipeline is empty or incompatible with runtime.",
          requestId,
        },
        422,
      );
    }

    const normalized = pipelineDefinitionSchema.safeParse(mappedPipeline);
    if (!normalized.success) {
      inFlightMessageRequests.set(key, {
        controller,
        state: "completed",
        touchedAt: Date.now(),
      });
      return c.json(
        {
          error:
            "Generated pipeline format is incompatible with runtime schema. Please retry.",
          details: normalized.error.flatten(),
          requestId,
        },
        422,
      );
    }
    response.pipelineState = normalized.data;

    const pipelineCheck = validatePipelineSecurity(
      response.pipelineState,
      userId,
      user?.plan || "free",
    );

    if (!pipelineCheck.valid) {
      await logSecurityEvent({
        type: "output_rejection",
        userId,
        sessionId,
        severity: "high",
        details: { errors: pipelineCheck.errors },
      });
      inFlightMessageRequests.set(key, {
        controller,
        state: "completed",
        touchedAt: Date.now(),
      });

      return c.json(
        {
          content:
            "I generated a pipeline, but it doesn't meet security requirements. Please try a different approach.",
          error: "Pipeline validation failed",
          details: pipelineCheck.errors,
          requestId,
        },
        400,
      );
    }

    response.pipelineState = pipelineCheck.sanitized || null;
  }

  let autoCreatedPipeline:
    | { id: string; name: string; created: boolean }
    | undefined;
  if (
    response.pipelineState &&
    shouldAutoPersistPipeline(parsed.data.action, effectiveUserMessage)
  ) {
    try {
      const result = await upsertPipelineFromChat({
        userId,
        sessionId,
        existingPipelineId: session.pipelineId,
        definition: response.pipelineState,
        suggestedName: sanitizedContent.slice(0, 80),
      });
      autoCreatedPipeline = {
        id: result.pipeline.id,
        name: result.pipeline.name,
        created: result.created,
      };
    } catch (err) {
      if (isPlanValidationError(err)) {
        inFlightMessageRequests.set(key, {
          controller,
          state: "completed",
          touchedAt: Date.now(),
        });
        return c.json(
          { error: err.message, code: err.code, details: err.details, requestId },
          err.status,
        );
      }
      if (err instanceof Error && err.message === "Pipeline creation rate limit exceeded") {
        inFlightMessageRequests.set(key, {
          controller,
          state: "completed",
          touchedAt: Date.now(),
        });
        return c.json(
          {
            error: "Pipeline creation rate limit exceeded. Please wait before creating more pipelines.",
            requestId,
          },
          429,
        );
      }
      throw err;
    }
  }

  if (autoCreatedPipeline) {
    const statusVerb = autoCreatedPipeline.created ? "created" : "updated";
    response.content = `${response.content}\n\nPipeline ${statusVerb}.`;
  }

  await db.insert(chatMessages).values({
    sessionId,
    role: "assistant",
    content: response.content,
    pipelineState: response.pipelineState,
    pipelineVersion: response.pipelineVersion,
    action: response.action,
  });

  inFlightMessageRequests.set(key, {
    controller,
    state: "completed",
    touchedAt: Date.now(),
  });

  if (response.pipelineState) {
    await db
      .update(chatSessions)
      .set({
        pipelineVersion: response.pipelineVersion || session.pipelineVersion,
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId));
  }

  if (!session.title || session.title === "New Chat") {
    const title = sanitizedContent.slice(0, 50);
    await db
      .update(chatSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
  }

  return c.json({ ...response, requestId, pipeline: autoCreatedPipeline });
});

chatRoutes.post("/sessions/:id/apply", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const parsed = applyPipelineSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  const [lastMessage] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  if (!lastMessage?.pipelineState) {
    return c.json({ error: "No pipeline state found in session" }, 400);
  }

  const definition = lastMessage.pipelineState as PipelineDefinition;

  if (!definition || !definition.steps || definition.steps.length === 0) {
    return c.json({ error: "Invalid pipeline state" }, 400);
  }

  try {
    await assertCanCreatePipeline(userId);
    await assertPipelineDefinitionWithinPlan(userId, definition);
  } catch (err) {
    if (isPlanValidationError(err)) {
      return c.json(
        { error: err.message, code: err.code, details: err.details },
        err.status,
      );
    }
    throw err;
  }

  let pipeline: typeof pipelines.$inferSelect;
  if (session.pipelineId) {
    const [existing] = await db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, session.pipelineId))
      .limit(1);

    if (existing) {
      const newVersion = existing.version + 1;
      [pipeline] = await db
        .update(pipelines)
        .set({
          name: parsed.data.name,
          description: parsed.data.description,
          definition,
          version: newVersion,
          updatedAt: new Date(),
        })
        .where(eq(pipelines.id, session.pipelineId))
        .returning();

      await db.insert(pipelineVersions).values({
        pipelineId: pipeline.id,
        version: newVersion,
        definition,
      });

      return c.json(pipeline);
    }
  }

  [pipeline] = await db
    .insert(pipelines)
    .values({
      userId,
      name: parsed.data.name,
      description: parsed.data.description,
      definition,
      status: "active",
    })
    .returning();

  await db.insert(pipelineVersions).values({
    pipelineId: pipeline.id,
    version: pipeline.version,
    definition,
  });

  await db
    .update(chatSessions)
    .set({ pipelineId: pipeline.id, updatedAt: new Date() })
    .where(eq(chatSessions.id, sessionId));

  return c.json(pipeline, 201);
});

chatRoutes.post("/sessions/:id/run", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const parsed = runPipelineSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  if (!session.pipelineId) {
    return c.json({ error: "No pipeline associated with this session" }, 400);
  }

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(eq(pipelines.id, session.pipelineId))
    .limit(1);

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const validation = validateInputAgainstPipelineSchema(
    pipeline.definition as PipelineDefinition,
    (parsed.data.input_data || {}) as Record<string, unknown>,
  );

  if (!validation.valid) {
    return c.json(
      {
        error: "Input validation failed",
        issues: validation.issues,
        details: { issues: validation.issues },
      },
      422,
    );
  }

  const [run] = await db
    .insert(runs)
    .values({
      pipelineId: session.pipelineId,
      pipelineVersion: pipeline.version,
      userId,
      triggerType: "manual",
      status: "pending",
      inputData: validation.data,
      fundingMode: "legacy",
    })
    .returning();

  await enqueueRun(run.id);

  return c.json(run, 202);
});

chatRoutes.get("/sessions/:id/runs", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  if (!session.pipelineId) {
    return c.json([]);
  }

  const result = await db
    .select()
    .from(runs)
    .where(eq(runs.pipelineId, session.pipelineId))
    .orderBy(desc(runs.createdAt))
    .limit(10);

  return c.json(result);
});

chatRoutes.get("/templates", async (c) => {
  const result = await db
    .select()
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.isPublic, true))
    .orderBy(desc(pipelineTemplates.usageCount));

  return c.json(result);
});

chatRoutes.get("/templates/:id", async (c) => {
  const templateId = c.req.param("id");

  const [template] = await db
    .select()
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.id, templateId))
    .limit(1);

  if (!template) return c.json({ error: "Template not found" }, 404);

  return c.json(template);
});

chatRoutes.post("/sessions/:id/from-template", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const templateId = body.templateId;

  if (!templateId) return c.json({ error: "Template ID required" }, 400);

  const [session] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);

  const [template] = await db
    .select()
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.id, templateId))
    .limit(1);

  if (!template) return c.json({ error: "Template not found" }, 404);

  await db.insert(chatMessages).values({
    sessionId,
    role: "system",
    content: `Template "${template.name}" loaded: ${template.description}`,
    pipelineState: template.definition,
    pipelineVersion: 1,
    action: "create",
  });

  await db
    .update(pipelineTemplates)
    .set({ usageCount: sql`${pipelineTemplates.usageCount} + 1` })
    .where(eq(pipelineTemplates.id, templateId));

  return c.json({ success: true, template });
});
