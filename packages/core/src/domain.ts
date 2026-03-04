export const STEP_TYPES = [
  "llm",
  "transform",
  "condition",
  "parallel",
  "webhook",
  "human_review",
  "code",
] as const;

export const SAFE_AGENT_TOOL_TYPES = [
  "http_request",
  "extract_json",
  "template_render",
  "curl",
] as const;

export const OUTPUT_FORMATS = ["text", "json", "markdown"] as const;

export const TRIGGER_TYPES = [
  "manual",
  "api",
  "cron",
  "webhook",
  "retry",
] as const;

export const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;

export const PIPELINE_STATUSES = ["draft", "active", "archived"] as const;

export const PLANS = ["free", "starter", "pro", "enterprise"] as const;
