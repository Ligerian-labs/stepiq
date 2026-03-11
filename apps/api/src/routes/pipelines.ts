import {
  createKmsProvider,
  createPipelineSchema,
  type PipelineDefinition,
  createScheduleSchema,
  createSecretSchema,
  encryptSecret,
  runPipelineSchema,
  secretNameParam,
  updatePipelineSchema,
  updateSecretSchema,
  uuidParam,
} from "@stepiq/core";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.js";
import {
  pipelineVersions,
  pipelines,
  runs,
  schedules,
  userSecrets,
} from "../db/schema.js";
import type { Env } from "../lib/env.js";
import { requireAuth } from "../middleware/auth.js";
import {
  assertCanCreatePipeline,
  assertCanUseCron,
  assertPipelineDefinitionWithinPlan,
  isPlanValidationError,
  resolveRunFundingModeForPipeline,
} from "../services/plan-validator.js";
import { enqueueRun } from "../services/queue.js";
import { createScheduleForPipeline } from "../services/schedule-create.js";
import { validateInputAgainstPipelineSchema } from "../services/input-schema.js";
import { validatePipelineSecurity } from "../services/pipeline-security.js";
import { checkRateLimit } from "../services/security-monitor.js";

export const pipelineRoutes = new Hono<{ Variables: Env }>();

let kmsProvider: ReturnType<typeof createKmsProvider> | null = null;
function getKms() {
  if (!kmsProvider) kmsProvider = createKmsProvider();
  return kmsProvider;
}

function kmsConfigError() {
  return {
    error:
      "Secrets encryption is not configured. Set STEPIQ_MASTER_KEY (64 hex chars) or VAULT_ADDR + VAULT_TOKEN.",
  };
}

function pipelineSecretsMigrationError() {
  return {
    error:
      "Pipeline-scoped secrets require the latest database schema. Please run migrations and retry.",
  };
}

function isMissingPipelineIdColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:no such column|column .* does not exist).*pipeline_id/i.test(
    error.message,
  );
}

pipelineRoutes.use("*", requireAuth);

// List pipelines
pipelineRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const result = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.userId, userId), eq(pipelines.status, "active")))
    .orderBy(pipelines.updatedAt);
  return c.json(result);
});

// Create pipeline
pipelineRoutes.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const parsed = createPipelineSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { name, description, definition, tags } = parsed.data;
  const userPlan = String(c.get("userPlan") || "free");

  const rateLimit = await checkRateLimit(userId, "pipeline_create");
  if (!rateLimit.allowed) {
    return c.json(
      {
        error: "Pipeline creation rate limit exceeded. Please wait before creating more pipelines.",
        resetAt: rateLimit.resetAt,
      },
      429,
    );
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

  const pipelineCheck = validatePipelineSecurity(definition, userId, userPlan);
  if (!pipelineCheck.valid) {
    return c.json(
      {
        error: "Pipeline definition failed security validation",
        details: pipelineCheck.errors,
      },
      400,
    );
  }
  const sanitizedDefinition = pipelineCheck.sanitized || definition;

  const [pipeline] = await db
    .insert(pipelines)
    .values({
      userId,
      name,
      description,
      definition: sanitizedDefinition,
      tags: tags || [],
      status: "active",
    })
    .returning();

  // Create initial version
  await db.insert(pipelineVersions).values({
    pipelineId: pipeline.id,
    version: 1,
    definition: sanitizedDefinition,
  });

  return c.json(pipeline, 201);
});

// Get pipeline
pipelineRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _idRaw = c.req.param("id");
  const _idParsed = uuidParam.safeParse(_idRaw);
  if (!_idParsed.success) return c.json({ error: "Invalid ID format" }, 400);
  const id = _idParsed.data;

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, id), eq(pipelines.userId, userId)))
    .limit(1);

  if (!pipeline) return c.json({ error: "Not found" }, 404);
  return c.json(pipeline);
});

// Update pipeline
pipelineRoutes.put("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _idRaw = c.req.param("id");
  const _idParsed = uuidParam.safeParse(_idRaw);
  if (!_idParsed.success) return c.json({ error: "Invalid ID format" }, 400);
  const id = _idParsed.data;
  const body = await c.req.json();
  const parsed = updatePipelineSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const [existing] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, id), eq(pipelines.userId, userId)))
    .limit(1);

  if (!existing) return c.json({ error: "Not found" }, 404);

  if (parsed.data.definition) {
    try {
      await assertPipelineDefinitionWithinPlan(userId, parsed.data.definition);
    } catch (err) {
      if (isPlanValidationError(err)) {
        return c.json(
          { error: err.message, code: err.code, details: err.details },
          err.status,
        );
      }
      throw err;
    }

    const pipelineCheck = validatePipelineSecurity(
      parsed.data.definition,
      userId,
      String(c.get("userPlan") || "free"),
    );
    if (!pipelineCheck.valid) {
      return c.json(
        {
          error: "Pipeline definition failed security validation",
          details: pipelineCheck.errors,
        },
        400,
      );
    }
    parsed.data.definition = pipelineCheck.sanitized || parsed.data.definition;
  }

  const newVersion = existing.version + 1;
  const updates: Record<string, unknown> = {
    ...parsed.data,
    version: newVersion,
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(pipelines)
    .set(updates)
    .where(eq(pipelines.id, id))
    .returning();

  // Save version snapshot
  if (parsed.data.definition) {
    await db.insert(pipelineVersions).values({
      pipelineId: id,
      version: newVersion,
      definition: parsed.data.definition,
    });
  }

  return c.json(updated);
});

// Delete pipeline
pipelineRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _idRaw = c.req.param("id");
  const _idParsed = uuidParam.safeParse(_idRaw);
  if (!_idParsed.success) return c.json({ error: "Invalid ID format" }, 400);
  const id = _idParsed.data;

  const [result] = await db
    .delete(pipelines)
    .where(and(eq(pipelines.id, id), eq(pipelines.userId, userId)))
    .returning({ id: pipelines.id });

  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json({ deleted: true });
});

// Trigger a pipeline run
pipelineRoutes.post("/:id/run", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _pidRaw = c.req.param("id");
  const _pidParsed = uuidParam.safeParse(_pidRaw);
  if (!_pidParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = _pidParsed.data;
  const body = await c.req.json().catch(() => ({}));
  const parsed = runPipelineSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
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

  let fundingMode: "legacy" | "app_credits" | "byok_required";
  try {
    const resolved = await resolveRunFundingModeForPipeline(
      userId,
      pipelineId,
      pipeline.definition as PipelineDefinition,
    );
    fundingMode = resolved.fundingMode;
  } catch (err) {
    if (isPlanValidationError(err)) {
      return c.json(
        { error: err.message, code: err.code, details: err.details },
        err.status,
      );
    }
    throw err;
  }

  const [run] = await db
    .insert(runs)
    .values({
      pipelineId,
      pipelineVersion: pipeline.version,
      userId,
      triggerType: "manual",
      status: "pending",
      inputData: validation.data,
      fundingMode,
    })
    .returning();

  await enqueueRun(run.id);
  return c.json(run, 202);
});

// List schedules for a pipeline
pipelineRoutes.get("/:id/schedules", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _pidRaw = c.req.param("id");
  const _pidParsed = uuidParam.safeParse(_pidRaw);
  if (!_pidParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = _pidParsed.data;
  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
    .limit(1);

  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const result = await db
    .select()
    .from(schedules)
    .where(eq(schedules.pipelineId, pipelineId));

  return c.json(result);
});

// List secrets for a pipeline (pipeline-scoped only)
pipelineRoutes.get("/:id/secrets", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = idParsed.data;

  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
    .limit(1);
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  let result: {
    id: string;
    name: string;
    keyVersion: number;
    createdAt: Date;
    updatedAt: Date;
  }[];
  try {
    result = await db
      .select({
        id: userSecrets.id,
        name: userSecrets.name,
        keyVersion: userSecrets.keyVersion,
        createdAt: userSecrets.createdAt,
        updatedAt: userSecrets.updatedAt,
      })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, userId),
          eq(userSecrets.pipelineId, pipelineId),
        ),
      )
      .orderBy(userSecrets.name);
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    return c.json([]);
  }

  return c.json(result);
});

// Create pipeline-scoped secret
pipelineRoutes.post("/:id/secrets", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = idParsed.data;

  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
    .limit(1);
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.json();
  const parsed = createSecretSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { name, value } = parsed.data;
  let existing: { id: string } | undefined;
  try {
    [existing] = await db
      .select({ id: userSecrets.id })
      .from(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, userId),
          eq(userSecrets.pipelineId, pipelineId),
          eq(userSecrets.name, name),
        ),
      )
      .limit(1);
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    return c.json(pipelineSecretsMigrationError(), 409);
  }
  if (existing) {
    return c.json(
      {
        error: `Secret "${name}" already exists for this pipeline. Use PUT to update.`,
      },
      409,
    );
  }

  let masterKey: Buffer;
  try {
    masterKey = await getKms().getMasterKey();
  } catch (error) {
    console.error(
      "Pipeline secrets KMS init failure:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(kmsConfigError(), 503);
  }

  const encryptedBlob = await encryptSecret(userId, value, masterKey);
  const encryptedValue = encryptedBlob.toString("base64");

  let secret:
    | {
        id: string;
        name: string;
        keyVersion: number;
        createdAt: Date;
        updatedAt: Date;
      }
    | undefined;
  try {
    [secret] = await db
      .insert(userSecrets)
      .values({ userId, pipelineId, name, encryptedValue, keyVersion: 1 })
      .returning({
        id: userSecrets.id,
        name: userSecrets.name,
        keyVersion: userSecrets.keyVersion,
        createdAt: userSecrets.createdAt,
        updatedAt: userSecrets.updatedAt,
      });
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    return c.json(pipelineSecretsMigrationError(), 409);
  }

  return c.json(secret, 201);
});

// Update pipeline-scoped secret
pipelineRoutes.put("/:id/secrets/:name", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = idParsed.data;
  const nameParsed = secretNameParam.safeParse(c.req.param("name"));
  if (!nameParsed.success) return c.json({ error: "Invalid secret name" }, 400);

  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
    .limit(1);
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const body = await c.req.json();
  const parsed = updateSecretSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  let masterKey: Buffer;
  try {
    masterKey = await getKms().getMasterKey();
  } catch (error) {
    console.error(
      "Pipeline secrets KMS init failure:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(kmsConfigError(), 503);
  }
  const encryptedBlob = await encryptSecret(
    userId,
    parsed.data.value,
    masterKey,
  );
  const encryptedValue = encryptedBlob.toString("base64");

  let updated:
    | {
        id: string;
        name: string;
        keyVersion: number;
        updatedAt: Date;
      }
    | undefined;
  try {
    [updated] = await db
      .update(userSecrets)
      .set({ encryptedValue, updatedAt: new Date() })
      .where(
        and(
          eq(userSecrets.userId, userId),
          eq(userSecrets.pipelineId, pipelineId),
          eq(userSecrets.name, nameParsed.data),
        ),
      )
      .returning({
        id: userSecrets.id,
        name: userSecrets.name,
        keyVersion: userSecrets.keyVersion,
        updatedAt: userSecrets.updatedAt,
      });
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    return c.json(pipelineSecretsMigrationError(), 409);
  }

  if (!updated) return c.json({ error: "Secret not found" }, 404);
  return c.json(updated);
});

// Delete pipeline-scoped secret
pipelineRoutes.delete("/:id/secrets/:name", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = idParsed.data;
  const nameParsed = secretNameParam.safeParse(c.req.param("name"));
  if (!nameParsed.success) return c.json({ error: "Invalid secret name" }, 400);

  const [pipeline] = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.userId, userId)))
    .limit(1);
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  let deleted: { id: string } | undefined;
  try {
    [deleted] = await db
      .delete(userSecrets)
      .where(
        and(
          eq(userSecrets.userId, userId),
          eq(userSecrets.pipelineId, pipelineId),
          eq(userSecrets.name, nameParsed.data),
        ),
      )
      .returning({ id: userSecrets.id });
  } catch (error) {
    if (!isMissingPipelineIdColumnError(error)) throw error;
    return c.json(pipelineSecretsMigrationError(), 409);
  }

  if (!deleted) return c.json({ error: "Secret not found" }, 404);
  return c.json({ deleted: true });
});

// Create schedule
pipelineRoutes.post("/:id/schedules", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const _pidRaw = c.req.param("id");
  const _pidParsed = uuidParam.safeParse(_pidRaw);
  if (!_pidParsed.success)
    return c.json({ error: "Invalid pipeline ID format" }, 400);
  const pipelineId = _pidParsed.data;
  const body = await c.req.json();
  const parsed = createScheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  try {
    await assertCanUseCron(userId);
  } catch (err) {
    if (isPlanValidationError(err)) {
      return c.json(
        { error: err.message, code: err.code, details: err.details },
        err.status,
      );
    }
    throw err;
  }

  const result = await createScheduleForPipeline(
    userId,
    pipelineId,
    parsed.data,
  );
  if (result.error) {
    if (result.error === "Pipeline not found")
      return c.json({ error: result.error }, 404);
    return c.json({ error: result.error }, 400);
  }

  return c.json(result.schedule, 201);
});

// Validate pipeline definition
pipelineRoutes.post("/validate", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ valid: false, errors: "Unauthorized" }, 401);

  const body = await c.req.json();
  const parsed = createPipelineSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ valid: false, errors: parsed.error.flatten() });
  }

  try {
    await assertCanCreatePipeline(userId);
    await assertPipelineDefinitionWithinPlan(userId, parsed.data.definition);
  } catch (err) {
    if (isPlanValidationError(err)) {
      return c.json({
        valid: false,
        errors: err.message,
        code: err.code,
        details: err.details,
      });
    }
    throw err;
  }

  const pipelineCheck = validatePipelineSecurity(
    parsed.data.definition,
    userId,
    String(c.get("userPlan") || "free"),
  );
  if (!pipelineCheck.valid) {
    return c.json({
      valid: false,
      errors: pipelineCheck.errors,
    });
  }

  return c.json({ valid: true });
});
