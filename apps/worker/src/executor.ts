import type { ConnectorProvider } from "@stepiq/core";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import Handlebars from "handlebars";
import postgres from "postgres";
import { serverTrack } from "./analytics.js";
import {
  deliverConnectorActionWithRetry,
  deliverConnectorFetchWithRetry,
} from "./connector-delivery.js";
import {
  PLAN_LIMITS,
  type PipelineDefinition,
  type Plan,
  type RunFundingMode,
  TOKENS_PER_CREDIT,
  createKmsProvider,
  decryptSecret,
  providerSecretNames,
  redactSecrets,
} from "./core-adapter.js";
import {
  pipelineVersions,
  runs,
  stepExecutions,
  userSecrets,
  users,
} from "./db-executor.js";
import { callModel } from "./model-router.js";
import { deliverWebhookWithRetry } from "./webhook-delivery.js";

const dbUrl =
  process.env.DATABASE_URL || "postgres://stepiq:stepiq@localhost:5432/stepiq";
const client = postgres(dbUrl);
const db = drizzle(client);

type ConnectorStepConfigLike = {
  mode?: "fetch" | "action";
  provider?: ConnectorProvider;
  query?: Record<string, unknown>;
  action?: string;
  target?: string;
  payload?: Record<string, unknown>;
  auth_secret_name?: string;
  idempotency_key?: string;
  privacy_mode?: "strict" | "balanced";
  max_items?: number;
  dry_run?: boolean;
};

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
  };
}

export async function executePipeline(runId: string) {
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
  const definition = version?.definition as unknown as PipelineDefinition;
  if (!definition) throw new Error("Pipeline definition not found");
  if (
    definition.output?.deliver?.some(
      (target) => (target as { type?: string }).type === "connector",
    )
  ) {
    throw new Error(
      "Legacy output.deliver connector targets are no longer supported. Use connector steps in definition.steps.",
    );
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
  let context: Record<string, unknown> = {
    input: run.inputData,
    vars: definition.variables || {},
    env: {},
    steps: {} as Record<string, { output: unknown }>,
  };

  let totalTokens = 0;
  let totalCostCents = 0;
  let creditsDeducted = false;
  const rawFundingMode =
    ((run.fundingMode || "legacy") as RunFundingMode) || "legacy";
  const fundingMode: RunFundingMode =
    rawFundingMode === "legacy" &&
    (runUser?.plan === "starter" || runUser?.plan === "pro") &&
    (runUser.creditsRemaining || 0) > 0
      ? "app_credits"
      : rawFundingMode;
  const platformApiKeys = resolvePlatformApiKeys();
  console.log(`🔐 Run ${runId} funding mode: ${fundingMode}`, {
    userPlan: runUser?.plan || "unknown",
    hasPlatformOpenAIKey: Boolean(platformApiKeys.openai),
  });

  try {
    envSecrets = await resolveUserSecrets(
      run.userId,
      run.pipelineId,
      definition,
      db,
      getRequiredSecretNames(definition),
      {
        includeProviderSecrets: fundingMode !== "app_credits",
      },
    );
    context = {
      ...context,
      env: envSecrets.values,
    };

    for (let i = 0; i < definition.steps.length; i++) {
      const step = definition.steps[i];

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

      try {
        const prompt = step.prompt ? interpolate(step.prompt, context) : "";
        const stepType = (step.type || "llm") as string;
        const startTime = Date.now();

        let rawOutput = "";
        let parsedOutput: unknown;
        let inputTokens = 0;
        let outputTokens = 0;
        let costCents = 0;

        if (stepType === "llm") {
          const result = await callModel({
            model: step.model || "gpt-5.2",
            prompt,
            system: step.system_prompt
              ? interpolate(step.system_prompt, context)
              : undefined,
            temperature: step.temperature,
            max_tokens: step.max_tokens,
            output_format: step.output_format,
            api_keys: {
              ...(fundingMode === "app_credits"
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
                  }),
            },
          });

          rawOutput = result.output;
          parsedOutput = result.output;
          inputTokens = result.input_tokens;
          outputTokens = result.output_tokens;
          costCents = result.cost_cents;

          if (step.output_format === "json") {
            try {
              parsedOutput = JSON.parse(result.output);
            } catch {
              parsedOutput = result.output;
            }
          }
        } else if (stepType === "transform") {
          rawOutput = prompt;
          parsedOutput = prompt;
        } else if (stepType === "connector") {
          const result = await executeConnectorStep({
            runId,
            stepId: step.id,
            stepIndex: i,
            connectorConfig: (
              step as unknown as { connector?: ConnectorStepConfigLike }
            ).connector,
            prompt,
            context,
            envValues: envSecrets.values,
          });
          rawOutput = result.rawOutput;
          parsedOutput = result.parsedOutput;
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
            durationMs,
            completedAt: new Date(),
          })
          .where(eq(stepExecutions.id, stepExec.id));
      } catch (stepErr) {
        const rawError =
          stepErr instanceof Error ? stepErr.message : String(stepErr);
        const error = redactSecrets(rawError, envSecrets.plainValues);

        await db
          .update(stepExecutions)
          .set({ status: "failed", error, completedAt: new Date() })
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
        completedAt,
      })
      .where(eq(runs.id, runId));

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
      })
      .where(eq(runs.id, runId));

    if (!creditsDeducted) {
      await deductRunCredits(
        run.id,
        run.userId,
        totalTokens,
        totalCostCents,
        fundingMode,
      );
    }
  }
}

function creditsFromTokens(totalTokens: number): number {
  if (totalTokens <= 0) return 0;
  return Math.ceil(totalTokens / TOKENS_PER_CREDIT);
}

async function deductRunCredits(
  runId: string,
  userId: string,
  totalTokens: number,
  totalCostCents: number,
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
  let creditsToDeduct = creditsFromTokens(totalTokens);
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

function getRequiredSecretNames(definition: PipelineDefinition): string[] {
  const names: string[] = [];
  for (const delivery of definition.output?.deliver || []) {
    if (delivery.type === "webhook") {
      const signingRaw = (delivery as Record<string, unknown>)
        .signing_secret_name;
      if (typeof signingRaw === "string" && signingRaw.length > 0) {
        names.push(signingRaw);
      }
    }
  }
  for (const step of definition.steps || []) {
    if ((step.type || "llm") !== "connector") continue;
    const connector = (
      step as unknown as { connector?: ConnectorStepConfigLike }
    ).connector;
    if (
      connector?.auth_secret_name &&
      typeof connector.auth_secret_name === "string" &&
      connector.auth_secret_name.length > 0
    ) {
      names.push(connector.auth_secret_name);
    }
  }
  return Array.from(new Set(names));
}

function interpolateUnknown(
  value: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof value === "string") return interpolate(value, context);
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateUnknown(entry, context));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, innerValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = interpolateUnknown(innerValue, context);
    }
    return out;
  }
  return value;
}

function resolveConnectorAuth(
  provider: ConnectorProvider,
  token: string,
): { access_token?: string; bot_token?: string } {
  if (provider === "gmail") return { access_token: token };
  if (provider === "discord") return { bot_token: token };
  return { access_token: token };
}

async function executeConnectorStep(params: {
  runId: string;
  stepId: string;
  stepIndex: number;
  connectorConfig?: ConnectorStepConfigLike;
  prompt: string;
  context: Record<string, unknown>;
  envValues: Record<string, string>;
}): Promise<{ rawOutput: string; parsedOutput: unknown }> {
  const config = params.connectorConfig;
  if (!config) {
    throw new Error(
      `Connector step "${params.stepId}" has no connector config`,
    );
  }
  const provider = config.provider;
  const mode = config.mode;
  if (!provider) {
    throw new Error(`Connector step "${params.stepId}" is missing provider`);
  }
  if (!mode) {
    throw new Error(`Connector step "${params.stepId}" is missing mode`);
  }
  const authSecretName = config.auth_secret_name;
  if (!authSecretName) {
    throw new Error(
      `Connector step "${params.stepId}" is missing auth_secret_name`,
    );
  }
  const providerToken = params.envValues[authSecretName];
  if (!providerToken) {
    throw new Error(
      `Connector step "${params.stepId}" secret "${authSecretName}" not found`,
    );
  }

  const gatewayUrl =
    process.env.CONNECTORS_GATEWAY_URL || "http://localhost:3002";
  const gatewayApiKey = process.env.CONNECTORS_GATEWAY_API_KEY || undefined;

  if (mode === "fetch") {
    const query = interpolateUnknown(
      config.query || {},
      params.context,
    ) as Record<string, unknown>;
    if (typeof config.max_items === "number" && config.max_items > 0) {
      query.max_items = config.max_items;
    }
    const fetchResult = await deliverConnectorFetchWithRetry({
      gatewayUrl,
      gatewayApiKey,
      request: {
        provider,
        query,
        auth: resolveConnectorAuth(provider, providerToken),
        dry_run: config.dry_run || false,
      },
    });
    const lastAttempt = fetchResult.attempts[fetchResult.attempts.length - 1];
    if (!lastAttempt?.ok) {
      throw new Error(
        `Connector fetch failed for ${provider} after ${fetchResult.attempts.length} attempt(s)`,
      );
    }
    const parsedOutput =
      fetchResult.responseBody && typeof fetchResult.responseBody === "object"
        ? fetchResult.responseBody
        : { provider, mode: "fetch", items: [] };
    return {
      rawOutput: JSON.stringify(parsedOutput),
      parsedOutput,
    };
  }

  if (mode === "action") {
    const payload = interpolateUnknown(
      config.payload || { prompt: params.prompt },
      params.context,
    ) as Record<string, unknown>;
    const idempotencyKey = (
      config.idempotency_key
        ? interpolate(config.idempotency_key, params.context)
        : `${params.runId}:${params.stepId}:${params.stepIndex + 1}:${provider}:${config.action || "action"}`
    ).slice(0, 200);
    const attempts = await deliverConnectorActionWithRetry({
      gatewayUrl,
      gatewayApiKey,
      providerToken,
      request: {
        provider,
        action: config.action || "action",
        target: config.target
          ? interpolate(config.target, params.context)
          : undefined,
        payload,
        idempotency_key: idempotencyKey,
        privacy_mode: config.privacy_mode || "strict",
        dry_run: config.dry_run || false,
      },
    });
    const lastAttempt = attempts[attempts.length - 1];
    if (!lastAttempt?.ok) {
      throw new Error(
        `Connector action failed for ${provider}/${config.action || "action"} after ${attempts.length} attempt(s)`,
      );
    }
    const parsedOutput = {
      provider,
      mode: "action",
      action: config.action || "action",
      target: config.target || null,
      idempotency_key: idempotencyKey,
      attempts,
    };
    return {
      rawOutput: JSON.stringify(parsedOutput),
      parsedOutput,
    };
  }

  throw new Error(`Unsupported connector mode "${mode}"`);
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
