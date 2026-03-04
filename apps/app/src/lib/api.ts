import type { PipelineDefinition } from "@stepiq/core";
import { getToken } from "./auth";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export interface ApiErrorShape {
  error?: string;
  message?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function toJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  auth = true,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");

  if (auth) {
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const data = await toJson(res);

  if (!res.ok) {
    const message =
      (data as ApiErrorShape | null)?.error ||
      (data as ApiErrorShape | null)?.message ||
      `Request failed (${res.status})`;
    throw new ApiError(
      res.status,
      message,
      (data as ApiErrorShape | null)?.code,
      (data as ApiErrorShape | null)?.details,
    );
  }

  return data as T;
}

export interface PipelineRecord {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  updatedAt?: string;
  updated_at?: string;
  definition?: PipelineDefinition;
}

export interface RunRecord {
  id: string;
  pipelineId?: string;
  pipeline_id?: string;
  status: string;
  error?: string | null;
  triggerType?: string;
  trigger_type?: string;
  totalTokens?: number;
  total_tokens?: number;
  totalCostCents?: number;
  total_cost_cents?: number;
  modelCostCents?: number;
  model_cost_cents?: number;
  toolCostCents?: number;
  tool_cost_cents?: number;
  toolCallsTotal?: number;
  tool_calls_total?: number;
  fundingMode?: "legacy" | "app_credits" | "byok_required";
  funding_mode?: "legacy" | "app_credits" | "byok_required";
  creditsDeducted?: number;
  credits_deducted?: number;
  createdAt?: string;
  created_at?: string;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  steps?: StepExecutionRecord[];
}

export interface StepExecutionRecord {
  id: string;
  stepId?: string;
  step_id?: string;
  stepIndex?: number;
  step_index?: number;
  status: string;
  model?: string | null;
  promptSent?: string | null;
  prompt_sent?: string | null;
  durationMs?: number | null;
  duration_ms?: number | null;
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  costCents?: number;
  cost_cents?: number;
  modelCostCents?: number;
  model_cost_cents?: number;
  toolCostCents?: number;
  tool_cost_cents?: number;
  toolCallsTotal?: number;
  tool_calls_total?: number;
  toolCallsSuccess?: number;
  tool_calls_success?: number;
  toolCallsFailed?: number;
  tool_calls_failed?: number;
  traceEventCount?: number;
  trace_event_count?: number;
  latestTraceSeq?: number;
  latest_trace_seq?: number;
  traceStatus?: "idle" | "streaming" | "completed" | "failed";
  trace_status?: "idle" | "streaming" | "completed" | "failed";
  agentTrace?: unknown;
  agent_trace?: unknown;
  agentLogs?: unknown;
  agent_logs?: unknown;
  traceEvents?: StepTraceEventRecord[];
  trace_events?: StepTraceEventRecord[];
  rawOutput?: string | null;
  raw_output?: string | null;
  parsedOutput?: unknown;
  parsed_output?: unknown;
  error?: string | null;
  retryCount?: number;
  retry_count?: number;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
}

export interface StepTraceEventRecord {
  id: string;
  stepExecutionId?: string;
  step_execution_id?: string;
  runId?: string;
  run_id?: string;
  stepId?: string;
  step_id?: string;
  seq: number;
  stepSeq?: number;
  step_seq?: number;
  kind: string;
  turn?: number | null;
  payload?: unknown;
  createdAt?: string;
  created_at?: string;
}

export interface UserMe {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  isAdmin?: boolean;
  creditsRemaining?: number;
  credits_remaining?: number;
}

export interface UsageRecord {
  credits_used: number;
  credits_remaining: number;
  runs_today: number;
  total_cost_cents: number;
}

export interface SecretRecord {
  id: string;
  name: string;
  pipelineId?: string | null;
  pipeline_id?: string | null;
  keyVersion?: number;
  key_version?: number;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string | null;
  keyPrefix?: string;
  key_prefix?: string;
  scopes: string[] | null;
  lastUsedAt?: string | null;
  last_used_at?: string | null;
  expiresAt?: string | null;
  expires_at?: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface CreatedApiKeyRecord extends ApiKeyRecord {
  key: string;
}

export interface BillingCheckoutRequest {
  plan: "starter" | "pro";
  interval: "month" | "year";
  discount_code?: string;
}

export interface BillingCheckoutResponse {
  url: string;
}

export interface BillingPortalResponse {
  url: string;
}

export interface AdminDiscountCode {
  id: string;
  code: string;
  active: boolean;
  kind: "percent_off" | "free_cycles";
  percentOff: number | null;
  freeCyclesCount: number | null;
  freeCyclesInterval: "month" | "year" | null;
  appliesToPlan: "starter" | "pro" | null;
  appliesToInterval: "month" | "year" | null;
  allowedEmails: string[];
  maxRedemptions: number | null;
  redeemedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  userId: string;
  pipelineId: string | null;
  title: string | null;
  modelId: string;
  pipelineVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  pipelineState: unknown;
  pipelineVersion: number | null;
  action: string | null;
  createdAt: string;
}
