// @ts-nocheck
import { describe, expect, it, mock } from "bun:test";
import { SignJWT } from "jose";

const TEST_SECRET = "test-secret-key-that-is-long-enough-for-testing-purposes";
const secret = new TextEncoder().encode(TEST_SECRET);

const tables = {
  users: {
    __name: "users",
    id: "users.id",
    plan: "users.plan",
    creditsRemaining: "users.creditsRemaining",
  },
  apiKeys: {
    __name: "apiKeys",
    id: "apiKeys.id",
    userId: "apiKeys.userId",
    keyHash: "apiKeys.keyHash",
    expiresAt: "apiKeys.expiresAt",
    scopes: "apiKeys.scopes",
    lastUsedAt: "apiKeys.lastUsedAt",
  },
  emailVerificationCodes: {
    __name: "emailVerificationCodes",
    id: "emailVerificationCodes.id",
    email: "emailVerificationCodes.email",
    codeHash: "emailVerificationCodes.codeHash",
    attempts: "emailVerificationCodes.attempts",
    expiresAt: "emailVerificationCodes.expiresAt",
    consumedAt: "emailVerificationCodes.consumedAt",
  },
  billingDiscountCodes: {
    __name: "billingDiscountCodes",
    id: "billingDiscountCodes.id",
    code: "billingDiscountCodes.code",
    active: "billingDiscountCodes.active",
    startsAt: "billingDiscountCodes.startsAt",
    expiresAt: "billingDiscountCodes.expiresAt",
  },
  pipelines: {
    __name: "pipelines",
    id: "pipelines.id",
    userId: "pipelines.userId",
    status: "pipelines.status",
    version: "pipelines.version",
  },
  pipelineVersions: {
    __name: "pipelineVersions",
    id: "pipelineVersions.id",
  },
  runs: {
    __name: "runs",
    id: "runs.id",
    userId: "runs.userId",
    createdAt: "runs.createdAt",
  },
  schedules: {
    __name: "schedules",
    id: "schedules.id",
    pipelineId: "schedules.pipelineId",
  },
  stepExecutions: { __name: "stepExecutions", id: "stepExecutions.id" },
  userSecrets: { __name: "userSecrets", id: "userSecrets.id" },
  stripeEvents: { __name: "stripeEvents", id: "stripeEvents.id" },
};

type State = {
  user: { id: string; plan: string; creditsRemaining: number };
  activePipelineCount: number;
  runsTodayCount: number;
  pipeline: {
    id: string;
    userId: string;
    version: number;
    status: string;
    definition: Record<string, unknown>;
  };
  insertedPipelines: number;
  insertedRuns: number;
  insertedSchedules: number;
};

const state: State = {
  user: {
    id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
    plan: "free",
    creditsRemaining: 100,
  },
  activePipelineCount: 0,
  runsTodayCount: 0,
  pipeline: {
    id: "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4",
    userId: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
    version: 1,
    status: "active",
    definition: {
      name: "plan-limit-pipeline",
      version: 1,
      steps: [{ id: "s1", type: "llm", model: "gpt-4o-mini", prompt: "Hi" }],
    },
  },
  insertedPipelines: 0,
  insertedRuns: 0,
  insertedSchedules: 0,
};

function getEqValue(cond: unknown, left: string): string | undefined {
  if (!cond || typeof cond !== "object") return undefined;
  const c = cond as Record<string, unknown>;
  if (c.type === "eq" && c.left === left && typeof c.right === "string") {
    return c.right;
  }
  if (c.type === "and" && Array.isArray(c.conds)) {
    for (const sub of c.conds) {
      const value = getEqValue(sub, left);
      if (value) return value;
    }
  }
  return undefined;
}

function queryResult(rows: unknown[]) {
  const promise = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
    orderBy: () => Promise<unknown[]>;
  };
  promise.limit = async () => rows;
  promise.orderBy = async () => rows;
  return promise;
}

mock.module("../db/schema.js", () => tables);
mock.module("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ type: "and", conds }),
  eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
  gte: (left: unknown, right: unknown) => ({ type: "gte", left, right }),
  gt: (left: unknown, right: unknown) => ({ type: "gt", left, right }),
  desc: (value: unknown) => ({ type: "desc", value }),
  lte: (left: unknown, right: unknown) => ({ type: "lte", left, right }),
  sql: (..._args: unknown[]) => ({ type: "sql" }),
  isNull: (left: unknown) => ({ type: "isNull", left }),
  or: (...conds: unknown[]) => ({ type: "or", conds }),
  inArray: (left: unknown, right: unknown[]) => ({
    type: "inArray",
    left,
    right,
  }),
}));

mock.module("../db/index.js", () => ({
  db: {
    select: () => ({
      from: (table: { __name: string }) => ({
        where: (cond: unknown) => {
          if (table.__name === "users") {
            return queryResult([state.user]);
          }
          if (table.__name === "pipelines") {
            const byId = getEqValue(cond, tables.pipelines.id);
            if (byId) return queryResult([state.pipeline]);

            const rows = Array.from({ length: state.activePipelineCount }).map(
              (_, idx) => ({
                id: `pipeline-${idx + 1}`,
              }),
            );
            return queryResult(rows);
          }
          if (table.__name === "runs") {
            const rows = Array.from({ length: state.runsTodayCount }).map(
              (_, idx) => ({
                id: `run-${idx + 1}`,
              }),
            );
            return queryResult(rows);
          }
          if (table.__name === "schedules") {
            return queryResult([]);
          }
          return queryResult([]);
        },
        orderBy: async () => [],
      }),
    }),
    insert: (table: { __name: string }) => ({
      values: (_values: Record<string, unknown>) => ({
        returning: async () => {
          if (table.__name === "pipelines") {
            state.insertedPipelines += 1;
            return [{ id: "new-pipeline", version: 1 }];
          }
          if (table.__name === "pipelineVersions") {
            return [{ id: "new-version" }];
          }
          if (table.__name === "runs") {
            state.insertedRuns += 1;
            return [{ id: "new-run" }];
          }
          if (table.__name === "schedules") {
            state.insertedSchedules += 1;
            return [{ id: "new-schedule" }];
          }
          return [{}];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => [],
      }),
    }),
  },
}));

mock.module("../services/queue.js", () => ({
  enqueueRun: () => Promise.resolve(),
}));
mock.module("../services/cron.js", () => ({
  getNextCronTick: () => new Date(Date.now() + 60_000),
}));

mock.module("../lib/env.js", () => ({
  config: {
    databaseUrl: "postgres://test:test@localhost:5432/test",
    redisUrl: "redis://localhost:6379",
    jwtSecret: TEST_SECRET,
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    stripePriceStarterMonthly: "",
    stripePriceStarterYearly: "",
    stripePriceProMonthly: "",
    stripePriceProYearly: "",
    appUrl: "http://localhost:5173",
    anthropicApiKey: "",
    openaiApiKey: "",
    corsOrigin: "*",
    port: 3001,
  },
}));

const { app } = await import("../app.js");

async function authHeaders() {
  const token = await new SignJWT({ sub: state.user.id, plan: state.user.plan })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("plan limit enforcement", () => {
  it("blocks creating a 4th active pipeline on free plan", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "free",
      creditsRemaining: 100,
    };
    state.activePipelineCount = 3;
    state.insertedPipelines = 0;
    const headers = await authHeaders();

    const res = await app.request("/api/pipelines", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "over-limit",
        definition: {
          name: "over-limit",
          version: 1,
          steps: [{ id: "s1", name: "Step 1", prompt: "Hello" }],
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLAN_MAX_PIPELINES");
    expect(state.insertedPipelines).toBe(0);
  });

  it("blocks cron schedule creation on free plan", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "free",
      creditsRemaining: 100,
    };
    const headers = await authHeaders();

    const res = await app.request(
      "/api/pipelines/a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4/schedules",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "free cron",
          cron_expression: "0 9 * * MON",
          timezone: "UTC",
        }),
      },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLAN_CRON_DISABLED");
    expect(state.insertedSchedules).toBe(0);
  });

  it("blocks manual run when daily run cap is reached on free plan", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "free",
      creditsRemaining: 100,
    };
    state.runsTodayCount = 10;
    state.insertedRuns = 0;
    const headers = await authHeaders();

    const res = await app.request(
      "/api/pipelines/a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4/run",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input_data: {} }),
      },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLAN_MAX_RUNS_PER_DAY");
    expect(state.insertedRuns).toBe(0);
  });

  it("requires BYOK when starter credits are exhausted", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "starter",
      creditsRemaining: 0,
    };
    state.runsTodayCount = 0;
    state.insertedRuns = 0;
    const headers = await authHeaders();

    const res = await app.request(
      "/api/pipelines/a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4/run",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input_data: {} }),
      },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLAN_BYOK_REQUIRED");
    expect(state.insertedRuns).toBe(0);
  });

  it("returns invalid for malformed validate payload", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "free",
      creditsRemaining: 100,
    };
    const headers = await authHeaders();

    const res = await app.request("/api/pipelines/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "bad",
        definition: { name: "bad", version: 1, steps: [] },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("returns plan error for validate when pipeline cap is reached", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "free",
      creditsRemaining: 100,
    };
    state.activePipelineCount = 3;
    const headers = await authHeaders();

    const res = await app.request("/api/pipelines/validate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "over-limit",
        definition: {
          name: "over-limit",
          version: 1,
          steps: [{ id: "s1", name: "Step 1", prompt: "Hello" }],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.code).toBe("PLAN_MAX_PIPELINES");
  });

  it("blocks connector steps on starter plan", async () => {
    state.user = {
      id: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      plan: "starter",
      creditsRemaining: 100,
    };
    state.activePipelineCount = 0;
    state.insertedPipelines = 0;
    const headers = await authHeaders();

    const res = await app.request("/api/pipelines", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "connector-on-starter",
        definition: {
          name: "connector-on-starter",
          version: 1,
          steps: [
            {
              id: "s1",
              name: "Fetch Gmail",
              type: "connector",
              connector: {
                mode: "fetch",
                provider: "gmail",
                auth_secret_name: "GMAIL_ACCESS_TOKEN",
                query: {},
              },
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("PLAN_CONNECTORS_DISABLED");
    expect(state.insertedPipelines).toBe(0);
  });
});
