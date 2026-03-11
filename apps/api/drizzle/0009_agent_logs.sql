ALTER TABLE "step_executions"
  ADD COLUMN IF NOT EXISTS "agent_logs" jsonb;
