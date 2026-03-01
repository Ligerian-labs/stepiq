import type { z } from "zod";
import type {
  CONNECTOR_PRIVACY_MODES,
  CONNECTOR_PROVIDERS,
  OUTPUT_FORMATS,
  PIPELINE_STATUSES,
  PLANS,
  RUN_STATUSES,
  STEP_STATUSES,
  STEP_TYPES,
  TRIGGER_TYPES,
} from "./domain";
import type {
  connectorActionRequestSchema,
  connectorStepConfigSchema,
  createApiKeySchema,
  createPipelineSchema,
  createScheduleSchema,
  pipelineDefinitionSchema,
  pipelineStepSchema,
  runPipelineSchema,
  sanitizedToolEventSchema,
} from "./schemas";

// ── Pipeline Types ──

export type StepType = (typeof STEP_TYPES)[number];

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type RunStatus = (typeof RUN_STATUSES)[number];

export type StepStatus = (typeof STEP_STATUSES)[number];

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export type Plan = (typeof PLANS)[number];

export type RunFundingMode = "legacy" | "app_credits" | "byok_required";

export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export type ConnectorPrivacyMode = (typeof CONNECTOR_PRIVACY_MODES)[number];

// ── Pipeline Definition ──

export interface PipelineVariable {
  type: "string" | "integer" | "boolean" | "number";
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface StepRetry {
  max_attempts: number;
  backoff_ms: number;
}

export interface StepCondition {
  if: string;
  goto: string;
  max_loops?: number;
}

export type PipelineStep = z.infer<typeof pipelineStepSchema>;

export interface DeliveryTarget {
  type: "webhook" | "email" | "file";
  url?: string;
  method?: string;
  signing_secret_name?: string;
  to?: string;
  subject?: string;
  path?: string;
}

export interface PipelineSchedule {
  enabled: boolean;
  cron: string;
  timezone: string;
}

export interface PipelineNotification {
  type: "email" | "webhook";
  to?: string;
  url?: string;
  subject?: string;
}

export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;

// ── API Response Types ──

export interface User {
  id: string;
  email: string;
  name: string | null;
  plan: Plan;
  credits_remaining: number;
  created_at: string;
}

export interface Pipeline {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  definition: PipelineDefinition;
  version: number;
  is_public: boolean;
  tags: string[];
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  pipeline_id: string;
  pipeline_version: number;
  user_id: string;
  trigger_type: TriggerType;
  status: RunStatus;
  input_data: Record<string, unknown>;
  output_data: Record<string, unknown> | null;
  error: string | null;
  total_tokens: number;
  total_cost_cents: number;
  funding_mode: RunFundingMode;
  credits_deducted: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface StepExecution {
  id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  model: string | null;
  status: StepStatus;
  prompt_sent: string | null;
  raw_output: string | null;
  parsed_output: unknown;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  duration_ms: number | null;
  error: string | null;
  retry_count: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface Schedule {
  id: string;
  pipeline_id: string;
  name: string;
  description: string | null;
  cron_expression: string;
  timezone: string;
  input_data: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
  max_tokens: number;
  supports_json: boolean;
}

export interface CostEstimate {
  total_credits: number;
  total_cost_cents: number;
  steps: {
    step_id: string;
    model: string;
    estimated_tokens: number;
    estimated_credits: number;
    estimated_cost_cents: number;
  }[];
}

export interface ApiKeyRecord {
  id: string;
  name: string | null;
  key_prefix: string;
  scopes: string[] | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreatedApiKeyResponse {
  id: string;
  name: string | null;
  key_prefix: string;
  scopes: string[] | null;
  expires_at: string | null;
  created_at: string;
  key: string;
}

// ── API Payloads ──

export type CreatePipelinePayload = z.infer<typeof createPipelineSchema>;

export type RunPipelinePayload = z.infer<typeof runPipelineSchema>;

export type CreateSchedulePayload = z.infer<typeof createScheduleSchema>;

export type CreateApiKeyPayload = z.infer<typeof createApiKeySchema>;

export type SanitizedToolEvent = z.infer<typeof sanitizedToolEventSchema>;

export type ConnectorActionRequest = z.infer<
  typeof connectorActionRequestSchema
>;

export type ConnectorStepConfig = z.infer<typeof connectorStepConfigSchema>;
