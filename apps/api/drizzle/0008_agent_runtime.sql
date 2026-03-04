ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "model_cost_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_cost_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_calls_total" integer DEFAULT 0 NOT NULL;

ALTER TABLE "step_executions"
  ADD COLUMN IF NOT EXISTS "model_cost_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_cost_cents" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_calls_total" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_calls_success" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tool_calls_failed" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "agent_trace" jsonb;
