import {
  type PipelineDefinition,
  listRunsQuery,
  uuidParam,
} from "@stepiq/core";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/index.js";
import {
  pipelineVersions,
  pipelines,
  runs,
  stepExecutions,
  stepTraceEvents,
} from "../db/schema.js";
import type { Env } from "../lib/env.js";
import { requireAuth } from "../middleware/auth.js";
import {
  isPlanValidationError,
  resolveRunFundingModeForPipeline,
} from "../services/plan-validator.js";
import { enqueueRun } from "../services/queue.js";

export const runRoutes = new Hono<{ Variables: Env }>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runRoutes.use("*", requireAuth);

// List runs
runRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const queryParsed = listRunsQuery.safeParse({
    pipeline_id: c.req.query("pipeline_id"),
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });
  if (!queryParsed.success)
    return c.json({ error: queryParsed.error.flatten() }, 400);

  const { pipeline_id, status, limit } = queryParsed.data;

  const whereClauses = [eq(runs.userId, userId)];
  if (pipeline_id) whereClauses.push(eq(runs.pipelineId, pipeline_id));
  if (status) whereClauses.push(eq(runs.status, status));

  const where =
    whereClauses.length === 1 ? whereClauses[0] : and(...whereClauses);
  const result = await db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return c.json(result);
});

// Get run details
runRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid run ID" }, 400);

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, idParsed.data), eq(runs.userId, userId)))
    .limit(1);

  if (!run) return c.json({ error: "Not found" }, 404);

  const steps = await db
    .select()
    .from(stepExecutions)
    .where(eq(stepExecutions.runId, idParsed.data))
    .orderBy(stepExecutions.stepIndex);

  const traceEvents = await db
    .select()
    .from(stepTraceEvents)
    .where(eq(stepTraceEvents.runId, idParsed.data))
    .orderBy(asc(stepTraceEvents.seq));

  const traceEventsByStep = new Map<string, unknown[]>();
  for (const event of traceEvents) {
    const existing = traceEventsByStep.get(event.stepExecutionId) || [];
    existing.push(event);
    traceEventsByStep.set(event.stepExecutionId, existing);
  }

  return c.json({
    ...run,
    steps: steps.map((step) => ({
      ...step,
      traceEvents: traceEventsByStep.get(step.id) || [],
    })),
  });
});

runRoutes.get("/:id/steps/:stepExecutionId/trace", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const runIdParsed = uuidParam.safeParse(c.req.param("id"));
  const stepExecIdParsed = uuidParam.safeParse(c.req.param("stepExecutionId"));
  if (!runIdParsed.success || !stepExecIdParsed.success) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const afterSeqRaw = c.req.query("after_seq");
  const limitRaw = c.req.query("limit");
  const afterSeq = afterSeqRaw ? Number(afterSeqRaw) : 0;
  const limit = limitRaw ? Number(limitRaw) : 500;
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    return c.json({ error: "Invalid after_seq" }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return c.json({ error: "Invalid limit" }, 400);
  }

  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runIdParsed.data), eq(runs.userId, userId)))
    .limit(1);
  if (!run) return c.json({ error: "Not found" }, 404);

  const [step] = await db
    .select({ id: stepExecutions.id })
    .from(stepExecutions)
    .where(
      and(
        eq(stepExecutions.id, stepExecIdParsed.data),
        eq(stepExecutions.runId, runIdParsed.data),
      ),
    )
    .limit(1);
  if (!step) return c.json({ error: "Not found" }, 404);

  const events = await db
    .select()
    .from(stepTraceEvents)
    .where(
      and(
        eq(stepTraceEvents.stepExecutionId, stepExecIdParsed.data),
        gt(stepTraceEvents.stepSeq, afterSeq),
      ),
    )
    .orderBy(asc(stepTraceEvents.stepSeq))
    .limit(limit);

  return c.json(events);
});

// Cancel a run
runRoutes.post("/:id/cancel", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid run ID" }, 400);

  const [result] = await db
    .update(runs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        eq(runs.id, idParsed.data),
        eq(runs.userId, userId),
        eq(runs.status, "running"),
      ),
    )
    .returning({ id: runs.id });

  if (!result)
    return c.json({ error: "Run not found or not cancellable" }, 404);
  return c.json({ cancelled: true });
});

// Retry a run by creating and enqueuing a new run
runRoutes.post("/:id/retry", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid run ID" }, 400);

  const [sourceRun] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, idParsed.data), eq(runs.userId, userId)))
    .limit(1);
  if (!sourceRun) return c.json({ error: "Run not found" }, 404);

  const [pipeline] = await db
    .select({ id: pipelines.id, definition: pipelines.definition })
    .from(pipelines)
    .where(
      and(
        eq(pipelines.id, sourceRun.pipelineId),
        eq(pipelines.userId, userId),
        eq(pipelines.status, "active"),
      ),
    )
    .limit(1);
  if (!pipeline) return c.json({ error: "Pipeline not found" }, 404);

  const [sourceVersion] = await db
    .select({ definition: pipelineVersions.definition })
    .from(pipelineVersions)
    .where(
      and(
        eq(pipelineVersions.pipelineId, sourceRun.pipelineId),
        eq(pipelineVersions.version, sourceRun.pipelineVersion),
      ),
    )
    .limit(1);
  const definition =
    (sourceVersion?.definition as PipelineDefinition | undefined) ||
    (pipeline.definition as PipelineDefinition);

  let fundingMode: "legacy" | "app_credits" | "byok_required";
  try {
    const resolved = await resolveRunFundingModeForPipeline(
      userId,
      sourceRun.pipelineId,
      definition,
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

  const [newRun] = await db
    .insert(runs)
    .values({
      pipelineId: sourceRun.pipelineId,
      pipelineVersion: sourceRun.pipelineVersion,
      userId,
      triggerType: "retry",
      status: "pending",
      inputData: sourceRun.inputData ?? {},
      fundingMode,
    })
    .returning();

  await enqueueRun(newRun.id);
  return c.json(newRun, 202);
});

// SSE stream for real-time updates
runRoutes.get("/:id/stream", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const idParsed = uuidParam.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid run ID" }, 400);

  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, idParsed.data), eq(runs.userId, userId)))
    .limit(1);

  if (!run) return c.json({ error: "Not found" }, 404);

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({ type: "connected", run_id: idParsed.data }),
      event: "connected",
    });

    let lastSeq = 0;
    let lastRunStatus = "";
    const deadlineMs = Date.now() + 120_000;

    while (Date.now() < deadlineMs) {
      const [latestRun] = await db
        .select({
          id: runs.id,
          status: runs.status,
          completedAt: runs.completedAt,
        })
        .from(runs)
        .where(and(eq(runs.id, idParsed.data), eq(runs.userId, userId)))
        .limit(1);

      if (!latestRun) break;

      const events = await db
        .select()
        .from(stepTraceEvents)
        .where(
          and(
            eq(stepTraceEvents.runId, idParsed.data),
            gt(stepTraceEvents.seq, lastSeq),
          ),
        )
        .orderBy(asc(stepTraceEvents.seq))
        .limit(250);

      for (const event of events) {
        lastSeq = event.seq;
        await stream.writeSSE({
          event: "trace_event",
          data: JSON.stringify(event),
        });

        if (event.kind.startsWith("step.")) {
          await stream.writeSSE({
            event: "step_status",
            data: JSON.stringify({
              run_id: idParsed.data,
              step_execution_id: event.stepExecutionId,
              step_id: event.stepId,
              status: event.kind.replace("step.", ""),
              seq: event.seq,
            }),
          });
        }
      }

      const runStatusKey = `${latestRun.status}:${latestRun.completedAt?.toISOString() || ""}`;
      if (runStatusKey !== lastRunStatus) {
        lastRunStatus = runStatusKey;
        await stream.writeSSE({
          event: "run_status",
          data: JSON.stringify({
            run_id: idParsed.data,
            status: latestRun.status,
            completed_at: latestRun.completedAt,
            last_seq: lastSeq,
          }),
        });
      }

      if (events.length === 0) {
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({
            run_id: idParsed.data,
            status: latestRun.status,
            last_seq: lastSeq,
          }),
        });
      }

      if (
        (latestRun.status === "completed" ||
          latestRun.status === "failed" ||
          latestRun.status === "cancelled") &&
        events.length === 0
      ) {
        break;
      }

      await sleep(1000);
    }
  });
});
