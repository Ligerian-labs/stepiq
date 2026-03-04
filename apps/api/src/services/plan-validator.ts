import {
  PLAN_LIMITS,
  type ModelProvider,
  type PipelineDefinition,
  type Plan,
  type RunFundingMode,
  providerSecretNames,
  providersForPipeline,
} from "@stepiq/core";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { pipelines, runs, userSecrets, users } from "../db/schema.js";
import { rollUserBillingCycleIfNeeded } from "./billing-cycle.js";

type PlanLimitCode =
  | "PLAN_USER_NOT_FOUND"
  | "PLAN_MAX_PIPELINES"
  | "PLAN_MAX_STEPS"
  | "PLAN_MAX_RUNS_PER_DAY"
  | "PLAN_CREDITS_EXHAUSTED"
  | "PLAN_BYOK_REQUIRED"
  | "PLAN_CRON_DISABLED"
  | "PLAN_WEBHOOKS_DISABLED"
  | "PLAN_API_DISABLED";

export class PlanValidationError extends Error {
  status: 403 | 404;
  code: PlanLimitCode;
  details?: Record<string, unknown>;

  constructor(
    code: PlanLimitCode,
    message: string,
    details?: Record<string, unknown>,
    status: 403 | 404 = 403,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isPlanValidationError(
  err: unknown,
): err is PlanValidationError {
  return err instanceof PlanValidationError;
}

function isMissingPipelineIdColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:no such column|column .* does not exist).*pipeline_id/i.test(
    error.message,
  );
}

async function getUserPlanState(userId: string): Promise<{
  plan: Plan;
  limits: (typeof PLAN_LIMITS)[Plan];
  creditsRemaining: number;
}> {
  await rollUserBillingCycleIfNeeded(userId);

  const [user] = await db
    .select({ plan: users.plan, creditsRemaining: users.creditsRemaining })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new PlanValidationError(
      "PLAN_USER_NOT_FOUND",
      "User not found",
      { userId },
      404,
    );
  }

  const plan = (user.plan in PLAN_LIMITS ? user.plan : "free") as Plan;
  return {
    plan,
    limits: PLAN_LIMITS[plan],
    creditsRemaining: user.creditsRemaining,
  };
}

function utcDayWindow(date = new Date()): { start: Date; end: Date } {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function assertWithinDailyRunLimit(
  userId: string,
  plan: Plan,
  maxRunsPerDay: number,
): Promise<void> {
  if (maxRunsPerDay < 0) return;

  const { start, end } = utcDayWindow();
  const runsToday = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.userId, userId),
        gte(runs.createdAt, start),
        lte(runs.createdAt, end),
      ),
    );

  if (runsToday.length >= maxRunsPerDay) {
    throw new PlanValidationError(
      "PLAN_MAX_RUNS_PER_DAY",
      "Daily run limit reached for current plan",
      {
        plan,
        limit: maxRunsPerDay,
        current: runsToday.length,
      },
    );
  }
}

async function missingProviderKeys(
  userId: string,
  pipelineId: string,
  requiredProviders: ModelProvider[],
): Promise<ModelProvider[]> {
  if (requiredProviders.length === 0) return [];

  const candidateNames = Array.from(
    new Set(
      requiredProviders.flatMap((provider) => providerSecretNames(provider)),
    ),
  );

  let secrets: Array<{ name: string; pipelineId: string | null }> = [];
  try {
    secrets = await db
      .select({
        name: userSecrets.name,
        pipelineId: userSecrets.pipelineId,
      })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, userId),
          inArray(userSecrets.name, candidateNames),
        ),
      );
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    const legacySecrets = await db
      .select({
        name: userSecrets.name,
      })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, userId),
          inArray(userSecrets.name, candidateNames),
        ),
      );
    secrets = legacySecrets.map((item) => ({ ...item, pipelineId: null }));
  }

  return requiredProviders.filter((provider) => {
    const names = providerSecretNames(provider);
    return !secrets.some(
      (secret) =>
        names.includes(secret.name) &&
        (secret.pipelineId === pipelineId || secret.pipelineId == null),
    );
  });
}

export async function resolveRunFundingModeForPipeline(
  userId: string,
  pipelineId: string,
  definition: PipelineDefinition,
): Promise<{
  fundingMode: RunFundingMode;
  plan: Plan;
}> {
  const { plan, limits, creditsRemaining } = await getUserPlanState(userId);
  await assertWithinDailyRunLimit(userId, plan, limits.max_runs_per_day);

  if (plan === "starter" || plan === "pro") {
    if (creditsRemaining > 0) {
      return { fundingMode: "app_credits", plan };
    }
    const requiredProviders = providersForPipeline(definition);
    const missingProviders = await missingProviderKeys(
      userId,
      pipelineId,
      requiredProviders,
    );
    if (missingProviders.length > 0) {
      throw new PlanValidationError(
        "PLAN_BYOK_REQUIRED",
        "Credits exhausted: bring your own provider keys to continue",
        {
          plan,
          missing_providers: missingProviders,
          remaining: creditsRemaining,
        },
      );
    }
    return { fundingMode: "byok_required", plan };
  }

  if (limits.credits >= 0 && creditsRemaining <= 0) {
    throw new PlanValidationError(
      "PLAN_CREDITS_EXHAUSTED",
      "Credits exhausted for current plan",
      { plan, remaining: creditsRemaining },
    );
  }

  return { fundingMode: "legacy", plan };
}

export async function assertCanCreatePipeline(userId: string): Promise<void> {
  const { plan, limits } = await getUserPlanState(userId);
  if (limits.max_pipelines < 0) return;

  const activePipelines = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.userId, userId), eq(pipelines.status, "active")));

  if (activePipelines.length >= limits.max_pipelines) {
    throw new PlanValidationError(
      "PLAN_MAX_PIPELINES",
      "Pipeline limit reached for current plan",
      {
        plan,
        limit: limits.max_pipelines,
        current: activePipelines.length,
      },
    );
  }
}

export async function assertPipelineDefinitionWithinPlan(
  userId: string,
  definition: PipelineDefinition,
): Promise<void> {
  const { plan, limits } = await getUserPlanState(userId);

  if (limits.max_steps_per_pipeline >= 0) {
    const stepCount = definition.steps?.length || 0;
    if (stepCount > limits.max_steps_per_pipeline) {
      throw new PlanValidationError(
        "PLAN_MAX_STEPS",
        "Step limit reached for current plan",
        {
          plan,
          limit: limits.max_steps_per_pipeline,
          current: stepCount,
        },
      );
    }
  }

  const hasWebhookDelivery = Boolean(
    definition.output?.deliver?.some((d) => d.type === "webhook"),
  );
  if (hasWebhookDelivery && !limits.webhooks_enabled) {
    throw new PlanValidationError(
      "PLAN_WEBHOOKS_DISABLED",
      "Webhook delivery is not enabled for current plan",
      { plan },
    );
  }

  const maxTurns = limits.agent_max_turns ?? 8;
  const maxDuration = limits.agent_max_duration_seconds ?? 120;
  const maxToolCalls = limits.agent_max_tool_calls ?? 3;

  for (const step of definition.steps || []) {
    if ((step.type || "llm") !== "llm") continue;
    const agent = step.agent || definition.agent_defaults;
    if (!agent) continue;

    if ((agent.max_turns ?? 0) > maxTurns) {
      throw new PlanValidationError(
        "PLAN_MAX_STEPS",
        `Agent max_turns exceeds plan limit (${maxTurns})`,
        { plan, step_id: step.id, limit: maxTurns },
      );
    }
    if ((agent.max_duration_seconds ?? 0) > maxDuration) {
      throw new PlanValidationError(
        "PLAN_MAX_STEPS",
        `Agent max_duration_seconds exceeds plan limit (${maxDuration})`,
        { plan, step_id: step.id, limit: maxDuration },
      );
    }
    if ((agent.max_tool_calls ?? 0) > maxToolCalls) {
      throw new PlanValidationError(
        "PLAN_MAX_STEPS",
        `Agent max_tool_calls exceeds plan limit (${maxToolCalls})`,
        { plan, step_id: step.id, limit: maxToolCalls },
      );
    }
  }
}

export async function assertCanTriggerRun(userId: string): Promise<void> {
  const { plan, limits, creditsRemaining } = await getUserPlanState(userId);
  if (limits.credits >= 0 && creditsRemaining <= 0) {
    throw new PlanValidationError(
      "PLAN_CREDITS_EXHAUSTED",
      "Credits exhausted for current plan",
      { plan, remaining: creditsRemaining },
    );
  }
  await assertWithinDailyRunLimit(userId, plan, limits.max_runs_per_day);
}

export async function assertCanUseCron(userId: string): Promise<void> {
  const { plan, limits } = await getUserPlanState(userId);
  if (limits.cron_enabled) return;

  throw new PlanValidationError(
    "PLAN_CRON_DISABLED",
    "Cron scheduling is not enabled for current plan",
    { plan },
  );
}

export async function assertCanUseApi(userId: string): Promise<void> {
  const { plan, limits } = await getUserPlanState(userId);
  if (limits.api_enabled) return;

  throw new PlanValidationError(
    "PLAN_API_DISABLED",
    "API access is not enabled for current plan",
    { plan },
  );
}
