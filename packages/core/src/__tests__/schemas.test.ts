import { describe, expect, it } from "bun:test";
import {
  connectorActionRequestSchema,
  createApiKeySchema,
  createPipelineSchema,
  createScheduleSchema,
  createSecretSchema,
  listPipelinesQuery,
  listRunsQuery,
  loginSchema,
  pipelineDefinitionSchema,
  pipelineStepSchema,
  registerSchema,
  runPipelineSchema,
  sanitizedToolEventSchema,
  secretNameParam,
  updateSecretSchema,
  uuidParam,
  webhookTriggerSchema,
} from "../schemas.js";

describe("registerSchema", () => {
  it("accepts valid registration", () => {
    const result = registerSchema.safeParse({
      email: "test@example.com",
      password: "securepass123",
      name: "Test User",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = registerSchema.safeParse({
      email: "not-an-email",
      password: "securepass123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects short password", () => {
    const result = registerSchema.safeParse({
      email: "test@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("allows optional name", () => {
    const result = registerSchema.safeParse({
      email: "test@example.com",
      password: "securepass123",
    });
    expect(result.success).toBe(true);
  });
});

describe("loginSchema", () => {
  it("accepts valid login", () => {
    const result = loginSchema.safeParse({
      email: "test@example.com",
      password: "pass",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty password", () => {
    const result = loginSchema.safeParse({
      email: "test@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("pipelineStepSchema", () => {
  it("accepts valid step", () => {
    const result = pipelineStepSchema.safeParse({
      id: "research",
      name: "Research trends",
      model: "gpt-4o",
      prompt: "Find trends about {{vars.topic}}",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid step ID (uppercase)", () => {
    const result = pipelineStepSchema.safeParse({
      id: "Research",
      name: "Research trends",
    });
    expect(result.success).toBe(false);
  });

  it("defaults type to llm", () => {
    const result = pipelineStepSchema.safeParse({
      id: "step1",
      name: "Step 1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("llm");
    }
  });

  it("accepts all valid step types", () => {
    const types = [
      "llm",
      "connector",
      "transform",
      "condition",
      "parallel",
      "webhook",
      "human_review",
      "code",
    ];
    for (const type of types) {
      const base = {
        id: "s1",
        name: "S",
        type,
      } as Record<string, unknown>;
      if (type === "connector") {
        base.connector = {
          mode: "fetch",
          provider: "gmail",
          auth_secret_name: "GMAIL_ACCESS_TOKEN",
        };
      }
      const result = pipelineStepSchema.safeParse(base);
      expect(result.success).toBe(true);
    }
  });

  it("rejects connector step without connector config", () => {
    const result = pipelineStepSchema.safeParse({
      id: "s1",
      name: "S",
      type: "connector",
    });
    expect(result.success).toBe(false);
  });

  it("accepts retry config", () => {
    const result = pipelineStepSchema.safeParse({
      id: "s1",
      name: "S",
      retry: { max_attempts: 3, backoff_ms: 2000 },
    });
    expect(result.success).toBe(true);
  });
});

describe("pipelineDefinitionSchema", () => {
  it("accepts valid definition", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "Test Pipeline",
      version: 1,
      steps: [
        { id: "step1", name: "Step 1", model: "gpt-4o-mini", prompt: "Hello" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty steps", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "Test",
      version: 1,
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts variables and input schema", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "Test",
      version: 1,
      variables: { lang: "fr", tone: "direct" },
      input: {
        schema: {
          topic: { type: "string", required: true },
        },
      },
      steps: [{ id: "s1", name: "S1", prompt: "{{vars.lang}}" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts output delivery config", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "Test",
      version: 1,
      steps: [{ id: "s1", name: "S1" }],
      output: {
        from: "s1",
        deliver: [
          {
            type: "webhook",
            url: "https://hook.example.com",
            signing_secret_name: "WEBHOOK_SIGNING_SECRET",
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects connector output delivery config", () => {
    const result = pipelineDefinitionSchema.safeParse({
      name: "Connector Test",
      version: 1,
      steps: [{ id: "s1", name: "S1" }],
      output: {
        from: "s1",
        deliver: [
          {
            type: "connector",
            provider: "slack",
            action: "post_message",
            target: "C123",
            payload: { text: "Done" },
            idempotency_key: "run:1:slack:post_message",
            privacy_mode: "strict",
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("connector schemas", () => {
  it("accepts sanitized tool event", () => {
    const result = sanitizedToolEventSchema.safeParse({
      event_id: "evt_1",
      occurred_at: "2026-01-01T00:00:00.000Z",
      source: "slack",
      event_type: "message.created",
      dedupe_key: "slack:evt_1",
      trace_id: "trace_1",
      text_clean: "hello [REDACTED]",
    });
    expect(result.success).toBe(true);
  });

  it("accepts connector action request", () => {
    const result = connectorActionRequestSchema.safeParse({
      provider: "discord",
      action: "post_message",
      target: "channel_123",
      payload: { text: "hello" },
      idempotency_key: "run_1:step_3",
      privacy_mode: "strict",
    });
    expect(result.success).toBe(true);
  });

  it("accepts github connector action request", () => {
    const result = connectorActionRequestSchema.safeParse({
      provider: "github",
      action: "create_issue",
      payload: { repo: "owner/repo", title: "Bug report" },
      idempotency_key: "run_1:step_4",
      privacy_mode: "strict",
    });
    expect(result.success).toBe(true);
  });
});

describe("createApiKeySchema", () => {
  it("accepts empty payload", () => {
    const result = createApiKeySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid payload", () => {
    const result = createApiKeySchema.safeParse({
      name: "Zapier trigger",
      scopes: ["webhooks:trigger"],
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid scope", () => {
    const result = createApiKeySchema.safeParse({
      scopes: ["admin:all"],
    });
    expect(result.success).toBe(false);
  });
});

describe("createPipelineSchema", () => {
  it("accepts valid payload", () => {
    const result = createPipelineSchema.safeParse({
      name: "My Pipeline",
      definition: {
        name: "My Pipeline",
        version: 1,
        steps: [{ id: "s1", name: "Step 1", prompt: "Hello" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional tags", () => {
    const result = createPipelineSchema.safeParse({
      name: "My Pipeline",
      definition: {
        name: "My Pipeline",
        version: 1,
        steps: [{ id: "s1", name: "Step 1" }],
      },
      tags: ["ai", "blog"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects too many tags", () => {
    const result = createPipelineSchema.safeParse({
      name: "My Pipeline",
      definition: {
        name: "My Pipeline",
        version: 1,
        steps: [{ id: "s1", name: "Step 1" }],
      },
      tags: Array(11).fill("tag"),
    });
    expect(result.success).toBe(false);
  });
});

describe("runPipelineSchema", () => {
  it("accepts empty input", () => {
    const result = runPipelineSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts input data", () => {
    const result = runPipelineSchema.safeParse({
      input_data: { topic: "AI trends" },
    });
    expect(result.success).toBe(true);
  });
});

describe("createScheduleSchema", () => {
  it("accepts valid schedule", () => {
    const result = createScheduleSchema.safeParse({
      name: "Weekly blog generation",
      description: "Generate weekly blog on Mondays",
      cron_expression: "0 9 * * 1",
      timezone: "Europe/Paris",
    });
    expect(result.success).toBe(true);
  });

  it("defaults timezone to UTC", () => {
    const result = createScheduleSchema.safeParse({
      name: "Daily digest",
      cron_expression: "0 9 * * *",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("UTC");
    }
  });

  it("rejects empty name", () => {
    const result = createScheduleSchema.safeParse({
      name: "   ",
      cron_expression: "0 9 * * *",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid cron field count", () => {
    const result = createScheduleSchema.safeParse({
      name: "Bad cron",
      cron_expression: "0 9 * *",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timezone", () => {
    const result = createScheduleSchema.safeParse({
      name: "Bad timezone",
      cron_expression: "0 9 * * *",
      timezone: "Mars/Olympus",
    });
    expect(result.success).toBe(false);
  });
});

// ── Secret Vault Schemas ──

describe("createSecretSchema", () => {
  it("accepts valid secret", () => {
    const result = createSecretSchema.safeParse({
      name: "OPENAI_KEY",
      value: "sk-abc123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts underscore-prefixed name", () => {
    const result = createSecretSchema.safeParse({
      name: "_INTERNAL",
      value: "v",
    });
    expect(result.success).toBe(true);
  });

  it("rejects name starting with number", () => {
    const result = createSecretSchema.safeParse({ name: "1BAD", value: "v" });
    expect(result.success).toBe(false);
  });

  it("rejects name with dashes", () => {
    const result = createSecretSchema.safeParse({ name: "MY-KEY", value: "v" });
    expect(result.success).toBe(false);
  });

  it("rejects name with spaces", () => {
    const result = createSecretSchema.safeParse({ name: "MY KEY", value: "v" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createSecretSchema.safeParse({ name: "", value: "v" });
    expect(result.success).toBe(false);
  });

  it("rejects empty value", () => {
    const result = createSecretSchema.safeParse({ name: "KEY", value: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 100 chars", () => {
    const result = createSecretSchema.safeParse({
      name: "A".repeat(101),
      value: "v",
    });
    expect(result.success).toBe(false);
  });

  it("rejects value longer than 10000 chars", () => {
    const result = createSecretSchema.safeParse({
      name: "KEY",
      value: "x".repeat(10_001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts value at max length (10000)", () => {
    const result = createSecretSchema.safeParse({
      name: "KEY",
      value: "x".repeat(10_000),
    });
    expect(result.success).toBe(true);
  });
});

describe("updateSecretSchema", () => {
  it("accepts valid value", () => {
    const result = updateSecretSchema.safeParse({ value: "new-value" });
    expect(result.success).toBe(true);
  });

  it("rejects empty value", () => {
    const result = updateSecretSchema.safeParse({ value: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing value", () => {
    const result = updateSecretSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("secretNameParam", () => {
  it("accepts valid names", () => {
    expect(secretNameParam.safeParse("MY_SECRET").success).toBe(true);
    expect(secretNameParam.safeParse("a").success).toBe(true);
    expect(secretNameParam.safeParse("_private").success).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(secretNameParam.safeParse("").success).toBe(false);
    expect(secretNameParam.safeParse("has-dash").success).toBe(false);
    expect(secretNameParam.safeParse("has space").success).toBe(false);
    expect(secretNameParam.safeParse("0starts").success).toBe(false);
  });
});

// ── Query / Param Validation ──

describe("uuidParam", () => {
  it("accepts valid UUIDs", () => {
    expect(
      uuidParam.safeParse("550e8400-e29b-41d4-a716-446655440000").success,
    ).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(uuidParam.safeParse("not-a-uuid").success).toBe(false);
    expect(uuidParam.safeParse("").success).toBe(false);
    expect(uuidParam.safeParse("12345").success).toBe(false);
  });
});

describe("listRunsQuery", () => {
  it("accepts empty query (defaults)", () => {
    const result = listRunsQuery.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it("accepts valid filters", () => {
    const result = listRunsQuery.safeParse({
      status: "running",
      pipeline_id: "550e8400-e29b-41d4-a716-446655440000",
      limit: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(listRunsQuery.safeParse({ status: "invalid" }).success).toBe(false);
  });

  it("coerces string limit to number", () => {
    const result = listRunsQuery.safeParse({ limit: "25" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it("rejects limit > 100", () => {
    expect(listRunsQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("listPipelinesQuery", () => {
  it("accepts empty query", () => {
    const result = listPipelinesQuery.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid status filter", () => {
    expect(listPipelinesQuery.safeParse({ status: "active" }).success).toBe(
      true,
    );
    expect(listPipelinesQuery.safeParse({ status: "archived" }).success).toBe(
      true,
    );
    expect(listPipelinesQuery.safeParse({ status: "draft" }).success).toBe(
      true,
    );
  });

  it("rejects invalid status", () => {
    expect(listPipelinesQuery.safeParse({ status: "deleted" }).success).toBe(
      false,
    );
  });
});

describe("webhookTriggerSchema", () => {
  it("accepts empty body", () => {
    expect(webhookTriggerSchema.safeParse({}).success).toBe(true);
  });

  it("accepts input_data", () => {
    const result = webhookTriggerSchema.safeParse({ input_data: { x: 1 } });
    expect(result.success).toBe(true);
  });

  it("passes through extra fields", () => {
    const result = webhookTriggerSchema.safeParse({
      input_data: {},
      extra: "ok",
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect((result.data as Record<string, unknown>).extra).toBe("ok");
  });
});
