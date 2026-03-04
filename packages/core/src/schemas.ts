import { z } from "zod";
import {
  OUTPUT_FORMATS,
  PIPELINE_STATUSES,
  RUN_STATUSES,
  SAFE_AGENT_TOOL_TYPES,
  STEP_TYPES,
} from "./domain";

// ── Step Schema ──

export const stepRetrySchema = z.object({
  max_attempts: z.number().int().min(1).max(5).default(1),
  backoff_ms: z.number().int().min(0).default(1000),
});

export const stepConditionSchema = z.object({
  if: z.string(),
  goto: z.string(),
  max_loops: z.number().int().min(1).max(10).optional(),
});

export const stepToolSchema = z.object({
  type: z.enum(SAFE_AGENT_TOOL_TYPES),
  name: z
    .string()
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      "Tool name must be alphanumeric with underscores",
    ),
  description: z.string().max(500).optional(),
  input_schema: z.record(z.unknown()).optional(),
  js_source: z.string().max(50_000).optional(),
});

export const stepAgentSchema = z.object({
  max_turns: z.number().int().min(1).max(50).default(8),
  max_duration_seconds: z.number().int().min(1).max(600).optional(),
  max_tool_calls: z.number().int().min(0).max(50).default(3),
  allow_parallel_tools: z.boolean().default(false),
  tools: z.array(stepToolSchema).max(30).optional(),
  network_allowlist: z.array(z.string().min(1).max(255)).max(100).optional(),
});

export const pipelineStepSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9_]+$/,
      "Step ID must be lowercase alphanumeric with underscores",
    ),
  name: z.string().min(1).max(100),
  type: z.enum(STEP_TYPES).default("llm"),
  model: z.string().optional(),
  prompt: z.string().optional(),
  system_prompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).optional(),
  output_format: z.enum(OUTPUT_FORMATS).default("text"),
  timeout_seconds: z.number().int().min(1).max(300).default(60),
  retry: stepRetrySchema.optional(),
  on_condition: z.array(stepConditionSchema).optional(),
  agent: stepAgentSchema.optional(),
});

// ── Pipeline Definition Schema ──

export const variableSchema = z.object({
  type: z.enum(["string", "integer", "boolean", "number"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

export const deliveryTargetSchema = z.object({
  type: z.enum(["webhook", "email", "file"]),
  url: z.string().url().optional(),
  method: z.enum(["GET", "POST", "PUT"]).optional(),
  signing_secret_name: z.string().min(1).max(100).optional(),
  to: z.string().email().optional(),
  subject: z.string().optional(),
  path: z.string().optional(),
});

export const scheduleSchema = z.object({
  enabled: z.boolean().default(true),
  cron: z.string().min(1),
  timezone: z.string().default("UTC"),
});

export const notificationSchema = z.object({
  type: z.enum(["email", "webhook"]),
  to: z.string().optional(),
  url: z.string().url().optional(),
  subject: z.string().optional(),
});

export const pipelineDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  version: z.number().int().min(1).default(1),
  variables: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  input: z
    .object({
      schema: z.record(variableSchema),
    })
    .optional(),
  steps: z.array(pipelineStepSchema).min(1).max(20),
  agent_defaults: stepAgentSchema.optional(),
  output: z
    .object({
      from: z.string(),
      deliver: z.array(deliveryTargetSchema).optional(),
    })
    .optional(),
  schedule: scheduleSchema.optional(),
  notifications: z
    .object({
      on_success: z.array(notificationSchema).optional(),
      on_failure: z.array(notificationSchema).optional(),
    })
    .optional(),
});

// ── API Payload Schemas ──

export const createPipelineSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: pipelineDefinitionSchema,
  tags: z.array(z.string().max(50)).max(10).optional(),
});

export const updatePipelineSchema = createPipelineSchema.partial();

export const runPipelineSchema = z.object({
  input_data: z.record(z.unknown()).optional(),
});

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  cron_expression: z
    .string()
    .trim()
    .regex(
      /^(\S+\s+){4}\S+$/,
      "Cron expression must have exactly 5 fields",
    ),
  timezone: z
    .string()
    .trim()
    .default("UTC")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
  input_data: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── Secret Vault Schemas ──

export const createSecretSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "Secret name must be alphanumeric with underscores",
    ),
  value: z.string().min(1).max(10_000),
});

export const updateSecretSchema = z.object({
  value: z.string().min(1).max(10_000),
});

export const secretNameParam = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

// ── Query / Param Validation ──

export const uuidParam = z.string().uuid("Invalid ID format");

export const listRunsQuery = z.object({
  pipeline_id: z.string().uuid().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listPipelinesQuery = z.object({
  status: z.enum(PIPELINE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── Webhook Trigger Schema ──

export const webhookTriggerSchema = z
  .object({
    input_data: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ── API Key Schemas ──

export const apiKeyScopeSchema = z.enum([
  "pipelines:read",
  "pipelines:execute",
  "webhooks:trigger",
]);

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  scopes: z.array(apiKeyScopeSchema).min(1).max(10).optional(),
  expires_at: z.string().datetime().optional(),
});
