// @ts-nocheck
import { describe, expect, it, mock } from "bun:test";

mock.module("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
          orderBy: () => Promise.resolve([]),
        }),
        orderBy: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  },
}));

mock.module("../lib/env.js", () => ({
  config: {
    databaseUrl: "postgres://test:test@localhost:5432/test",
    redisUrl: "redis://localhost:6379",
    jwtSecret: "test-secret-key-that-is-long-enough-for-testing-purposes",
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    corsOrigin: "*",
    port: 3001,
  },
}));

const { app } = await import("../app.js");

describe("Health check", () => {
  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeDefined();
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await app.request("/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

describe("Auth routes", () => {
  it("POST /api/auth/register rejects invalid body", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/login rejects invalid body", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/auth/github/start returns 503 when GitHub OAuth is not configured", async () => {
    const res = await app.request("/api/auth/github/start");
    expect(res.status).toBe(503);
  });

  it("GET /api/auth/github/callback returns 503 when GitHub OAuth is not configured", async () => {
    const res = await app.request("/api/auth/github/callback?code=abc&state=def");
    expect(res.status).toBe(503);
  });

  it("GET /api/auth/google/start returns 503 when Google OAuth is not configured", async () => {
    const res = await app.request("/api/auth/google/start");
    expect(res.status).toBe(503);
  });

  it("GET /api/auth/google/callback returns 503 when Google OAuth is not configured", async () => {
    const res = await app.request("/api/auth/google/callback?code=abc&state=def");
    expect(res.status).toBe(503);
  });

  it("POST /api/auth/clerk/exchange returns 503 when Clerk is not configured", async () => {
    const res = await app.request("/api/auth/clerk/exchange", {
      method: "POST",
      headers: { Authorization: "Bearer whatever" },
    });
    expect(res.status).toBe(503);
  });
});

describe("Protected routes require auth", () => {
  const protectedPaths = [
    ["GET", "/api/pipelines"],
    ["POST", "/api/pipelines"],
    ["GET", "/api/runs"],
    ["GET", "/api/user/me"],
    ["GET", "/api/user/usage"],
    ["GET", "/api/user/secrets"],
  ];

  for (const [method, path] of protectedPaths) {
    it(`${method} ${path} returns 401 without token`, async () => {
      const res = await app.request(path, { method });
      expect(res.status).toBe(401);
    });
  }
});

describe("Models route", () => {
  it("GET /api/models returns model list", async () => {
    const res = await app.request("/api/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("provider");
    expect(body[0]).toHaveProperty("input_cost_per_million");
  });

  it("models have markup applied", async () => {
    const res = await app.request("/api/models");
    const body = await res.json();
    const mini = body.find((m: { id: string }) => m.id === "gpt-4o-mini");
    expect(mini).toBeDefined();
    expect(mini.input_cost_per_million).toBe(Math.ceil(150 * 1.25));
  });

  it("includes z.ai models with markup applied", async () => {
    const res = await app.request("/api/models");
    const body = await res.json();
    const glm5 = body.find((m: { id: string }) => m.id === "glm-5");
    expect(glm5).toBeDefined();
    expect(glm5.provider).toBe("zai");
    expect(glm5.input_cost_per_million).toBe(Math.ceil(20 * 1.25));
  });
});

describe("Webhook route", () => {
  it("POST /api/webhooks/dev/outbound captures payload in dev mode", async () => {
    const res = await app.request("/api/webhooks/dev/outbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-StepIQ-Event": "pipeline.run.completed",
      },
      body: JSON.stringify({ run_id: "run-123", status: "completed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.body.run_id).toBe("run-123");
  });

  it("GET /api/webhooks/dev/outbound/events returns captured events", async () => {
    const res = await app.request("/api/webhooks/dev/outbound/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(0);
  });

  it("DELETE /api/webhooks/dev/outbound/events clears captured events", async () => {
    const res = await app.request("/api/webhooks/dev/outbound/events", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared).toBe(true);
  });

  it("POST /api/webhooks/:id requires API key", async () => {
    const res = await app.request(
      "/api/webhooks/550e8400-e29b-41d4-a716-446655440000",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/webhooks/:id accepts api_key query parameter", async () => {
    const res = await app.request(
      "/api/webhooks/550e8400-e29b-41d4-a716-446655440000?api_key=sk_live_test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid API key");
  });

  it("dev outbound endpoints are disabled in production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const postRes = await app.request("/api/webhooks/dev/outbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: "run-prod" }),
      });
      expect(postRes.status).toBe(404);

      const getRes = await app.request("/api/webhooks/dev/outbound/events");
      expect(getRes.status).toBe(404);

      const deleteRes = await app.request("/api/webhooks/dev/outbound/events", {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(404);
    } finally {
      if (previous === undefined) {
        process.env.NODE_ENV = undefined;
      } else {
        process.env.NODE_ENV = previous;
      }
    }
  });
});
