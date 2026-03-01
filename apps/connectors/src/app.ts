import { randomUUID } from "node:crypto";
import {
  connectorActionRequestSchema,
  connectorProviderSchema,
  sanitizedToolEventSchema,
} from "@stepiq/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { fetchFromSource } from "./fetchers.js";
import {
  persistRawPayload,
  sanitizeActionPayload,
  sanitizeInboundEvent,
} from "./policy.js";
import { executeProviderAction } from "./providers.js";

export const app = new Hono();
const idempotencyCache = new Map<
  string,
  { expiresAt: number; response: Record<string, unknown> }
>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const inboundFetchSchema = z.object({
  provider: connectorProviderSchema,
  pipeline_id: z.string().min(1),
  query: z.record(z.unknown()).optional(),
  auth: z
    .object({
      access_token: z.string().optional(),
      bot_token: z.string().optional(),
    })
    .optional(),
  dry_run: z.boolean().default(false),
});

const stepFetchSchema = z.object({
  provider: connectorProviderSchema,
  query: z.record(z.unknown()).optional(),
  auth: z
    .object({
      access_token: z.string().optional(),
      bot_token: z.string().optional(),
    })
    .default({}),
  dry_run: z.boolean().default(false),
});

function requireIngressToken(c: Context) {
  const requiredToken = process.env.CONNECTORS_INGEST_TOKEN || "";
  if (!requiredToken) return null;
  const token = c.req.header("X-Connector-Ingest-Token") || "";
  if (token !== requiredToken) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function requireGatewayApiKey(c: Context) {
  const requiredApiKey = process.env.CONNECTORS_GATEWAY_API_KEY || "";
  if (!requiredApiKey) return null;
  const apiKey = c.req.header("X-Connectors-Api-Key") || "";
  if (apiKey !== requiredApiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

async function forwardSanitizedEvent(params: {
  provider: z.infer<typeof connectorProviderSchema>;
  pipelineId: string;
  payload: Record<string, unknown>;
  traceId?: string;
}): Promise<{
  accepted: boolean;
  trace_id: string;
  webhook_response: unknown;
}> {
  const traceId = params.traceId || randomUUID();
  const rawRef = await persistRawPayload({ payload: params.payload, traceId });
  const sanitized = sanitizeInboundEvent({
    provider: params.provider,
    payload: params.payload,
    traceId,
    rawRef,
  });

  const eventParsed = sanitizedToolEventSchema.safeParse(sanitized);
  if (!eventParsed.success) {
    throw new Error(
      `Sanitized event validation failed: ${JSON.stringify(eventParsed.error.flatten())}`,
    );
  }

  const stepiqUrl =
    process.env.CONNECTORS_STEPIQ_URL || "http://localhost:3001";
  const apiKeyFromBody =
    typeof params.payload.pipeline_api_key === "string"
      ? params.payload.pipeline_api_key
      : "";
  const stepiqApiKey =
    apiKeyFromBody || process.env.CONNECTORS_STEPIQ_API_KEY || "";
  if (!stepiqApiKey) {
    throw new Error(
      "Missing CONNECTORS_STEPIQ_API_KEY (or pipeline_api_key in payload)",
    );
  }

  const response = await fetch(
    `${stepiqUrl.replace(/\/$/, "")}/api/webhooks/${params.pipelineId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": stepiqApiKey,
      },
      body: JSON.stringify({ input_data: eventParsed.data }),
    },
  );

  const text = await response.text();
  let parsedText: unknown = text;
  try {
    parsedText = JSON.parse(text);
  } catch {
    // keep raw text
  }

  return {
    accepted: response.ok,
    trace_id: traceId,
    webhook_response: parsedText,
  };
}

app.use("*", logger());
app.use("*", cors());
app.use(
  "*",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) =>
      c.json({ error: "Request body too large (max 256KB)" }, 413),
  }),
);

app.get("/health", (c) => c.json({ status: "ok", service: "connectors" }));

app.post("/inbound/:provider/:pipelineId", async (c) => {
  const authError = requireIngressToken(c);
  if (authError) return authError;

  const providerParsed = connectorProviderSchema.safeParse(
    c.req.param("provider"),
  );
  if (!providerParsed.success) {
    return c.json({ error: "Unsupported provider" }, 400);
  }

  const requiredToken = process.env.CONNECTORS_INGEST_TOKEN || "";
  if (requiredToken) {
    const token = c.req.header("X-Connector-Ingest-Token") || "";
    if (token !== requiredToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const pipelineId = c.req.param("pipelineId");
  try {
    const result = await forwardSanitizedEvent({
      provider: providerParsed.data,
      pipelineId,
      payload: body as Record<string, unknown>,
    });
    return c.json(
      {
        accepted: result.accepted,
        provider: providerParsed.data,
        trace_id: result.trace_id,
        pipeline_id: pipelineId,
        webhook_response: result.webhook_response,
      },
      result.accepted ? 202 : 502,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("validation failed")
      ? 422
      : message.includes("Missing CONNECTORS_STEPIQ_API_KEY")
        ? 500
        : 502;
    return c.json({ error: message }, status);
  }
});

app.post("/inbound/fetch", async (c) => {
  const authError = requireIngressToken(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => null);
  const parsed = inboundFetchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const request = parsed.data;
  const fetchedItems = await fetchFromSource({
    provider: request.provider,
    query: request.query,
    auth: request.auth,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Source fetch failed: ${message}`);
  });

  const results: Array<{
    event_id: string;
    accepted: boolean;
    trace_id?: string;
    error?: string;
  }> = [];
  for (const item of fetchedItems) {
    const payload: Record<string, unknown> = {
      event_id: item.event_id,
      event_type: item.event_type,
      workspace_id: item.workspace_id,
      channel_id: item.channel_id,
      user_id: item.user_id,
      message_id: item.message_id,
      text: item.text,
      entities: item.entities || {},
    };

    if (request.dry_run) {
      results.push({ event_id: item.event_id, accepted: true });
      continue;
    }

    try {
      const sent = await forwardSanitizedEvent({
        provider: request.provider,
        pipelineId: request.pipeline_id,
        payload,
      });
      results.push({
        event_id: item.event_id,
        accepted: sent.accepted,
        trace_id: sent.trace_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        event_id: item.event_id,
        accepted: false,
        error: message,
      });
    }
  }

  const acceptedCount = results.filter((result) => result.accepted).length;
  return c.json(
    {
      provider: request.provider,
      pipeline_id: request.pipeline_id,
      fetched_count: fetchedItems.length,
      accepted_count: acceptedCount,
      failed_count: fetchedItems.length - acceptedCount,
      dry_run: request.dry_run,
      results,
    },
    200,
  );
});

app.post("/steps/fetch", async (c) => {
  const authError = requireGatewayApiKey(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => null);
  const parsed = stepFetchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const request = parsed.data;
  const fetchedItems = await fetchFromSource({
    provider: request.provider,
    query: request.query,
    auth: request.auth,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Source fetch failed: ${message}`);
  });

  const traceId = randomUUID();
  const sanitizedItems: Array<Record<string, unknown>> = [];
  for (const item of fetchedItems) {
    const payload: Record<string, unknown> = {
      event_id: item.event_id,
      event_type: item.event_type,
      workspace_id: item.workspace_id,
      channel_id: item.channel_id,
      user_id: item.user_id,
      message_id: item.message_id,
      text: item.text,
      entities: item.entities || {},
    };
    const rawRef = request.dry_run
      ? undefined
      : await persistRawPayload({ payload, traceId });
    const sanitized = sanitizeInboundEvent({
      provider: request.provider,
      payload,
      traceId,
      rawRef,
    });
    sanitizedItems.push(sanitized);
  }

  return c.json({
    ok: true,
    provider: request.provider,
    mode: "fetch",
    fetched_count: fetchedItems.length,
    dry_run: request.dry_run,
    items: sanitizedItems,
  });
});

app.post("/actions/execute", async (c) => {
  const authError = requireGatewayApiKey(c);
  if (authError) return authError;

  const body = await c.req.json().catch(() => null);
  const parsed = connectorActionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const request = {
    ...parsed.data,
    payload: sanitizeActionPayload(parsed.data.payload || {}),
  };

  const now = Date.now();
  for (const [key, value] of idempotencyCache.entries()) {
    if (value.expiresAt <= now) idempotencyCache.delete(key);
  }
  const existing = idempotencyCache.get(request.idempotency_key);
  if (existing && existing.expiresAt > now) {
    return c.json({ ok: true, cached: true, ...existing.response });
  }

  const result = await executeProviderAction(request);
  const responsePayload = {
    ok: true,
    request: {
      provider: request.provider,
      action: request.action,
      target: request.target,
      idempotency_key: request.idempotency_key,
      privacy_mode: request.privacy_mode,
    },
    result,
  };
  idempotencyCache.set(request.idempotency_key, {
    expiresAt: now + IDEMPOTENCY_TTL_MS,
    response: responsePayload,
  });
  return c.json(responsePayload);
});
