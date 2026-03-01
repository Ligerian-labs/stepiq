export const STEP_TYPES = [
  "llm",
  "connector",
  "transform",
  "condition",
  "parallel",
  "webhook",
  "human_review",
  "code",
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

export const CONNECTOR_PROVIDERS = [
  "gmail",
  "github",
  "slack",
  "discord",
  "telegram",
  "linear",
  "jira",
  "monday",
  "s3",
] as const;

export const CONNECTOR_PRIVACY_MODES = ["strict", "balanced"] as const;
