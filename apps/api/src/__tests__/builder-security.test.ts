import { beforeEach, describe, expect, it, mock } from "bun:test";

const tables = {
  chatSessions: {
    __name: "chatSessions",
    id: "chatSessions.id",
    userId: "chatSessions.userId",
  },
  chatMessages: {
    __name: "chatMessages",
    sessionId: "chatMessages.sessionId",
    createdAt: "chatMessages.createdAt",
  },
  pipelines: {
    __name: "pipelines",
    userId: "pipelines.userId",
    createdAt: "pipelines.createdAt",
  },
  users: {
    __name: "users",
    id: "users.id",
    plan: "users.plan",
  },
};

type RowState = {
  sessions: Array<{ id: string; userId: string }>;
  messages: Array<{ sessionId: string; createdAt: Date }>;
  pipelines: Array<{ userId: string; createdAt: Date }>;
  users: Array<{ id: string; plan: string }>;
};

let state: RowState;

function queryResult(rows: Record<string, unknown>[], fields?: Record<string, unknown>) {
  const selectRows = (items: Record<string, unknown>[]) => {
    if (!fields) return items;
    if ("count" in fields) return [{ count: items.length }];
    return items.map((row) =>
      Object.fromEntries(
        Object.entries(fields).map(([alias, ref]) => {
          const key = String(ref).split(".").pop() as string;
          return [alias, row[key]];
        }),
      ),
    );
  };

  const makeResult = (items: Record<string, unknown>[]) => {
    const promise = Promise.resolve(selectRows(items)) as Promise<unknown[]> & {
      limit: (n: number) => Promise<unknown[]>;
      orderBy: (spec: { type: string; value: unknown }) => ReturnType<typeof makeResult>;
    };
    promise.limit = async (n: number) => selectRows(items.slice(0, n));
    promise.orderBy = (spec: { type: string; value: unknown }) => {
      const key = String(spec.value).split(".").pop() as string;
      const sorted = [...items].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av instanceof Date && bv instanceof Date) {
          return av.getTime() - bv.getTime();
        }
        return String(av).localeCompare(String(bv));
      });
      return makeResult(sorted);
    };
    return promise;
  };

  return makeResult(rows);
}

function matchesCondition(row: Record<string, unknown>, cond: unknown): boolean {
  if (!cond || typeof cond !== "object") return true;
  const value = cond as Record<string, unknown>;
  if (value.type === "and" && Array.isArray(value.conds)) {
    return value.conds.every((item) => matchesCondition(row, item));
  }
  if (value.type === "eq") {
    const key = String(value.left).split(".").pop() as string;
    return row[key] === value.right;
  }
  if (value.type === "gte") {
    const key = String(value.left).split(".").pop() as string;
    return row[key] instanceof Date &&
      value.right instanceof Date &&
      (row[key] as Date).getTime() >= value.right.getTime();
  }
  if (value.type === "inArray") {
    const key = String(value.left).split(".").pop() as string;
    return Array.isArray(value.right) && value.right.includes(row[key]);
  }
  return true;
}

mock.module("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ type: "and", conds }),
  asc: (value: unknown) => ({ type: "asc", value }),
  eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
  gte: (left: unknown, right: unknown) => ({ type: "gte", left, right }),
  inArray: (left: unknown, right: unknown[]) => ({ type: "inArray", left, right }),
  sql: (..._args: unknown[]) => ({ type: "sql" }),
}));

mock.module("../db/schema.js", () => tables);
mock.module("../db/index.js", () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: { __name: string }) => ({
        where: (cond: unknown) => {
          if (table.__name === "chatSessions") {
            return queryResult(
              state.sessions.filter((row) =>
                matchesCondition(row as Record<string, unknown>, cond),
              ) as unknown as Record<string, unknown>[],
              fields,
            );
          }
          if (table.__name === "chatMessages") {
            return queryResult(
              state.messages.filter((row) =>
                matchesCondition(row as Record<string, unknown>, cond),
              ) as unknown as Record<string, unknown>[],
              fields,
            );
          }
          if (table.__name === "pipelines") {
            return queryResult(
              state.pipelines.filter((row) =>
                matchesCondition(row as Record<string, unknown>, cond),
              ) as unknown as Record<string, unknown>[],
              fields,
            );
          }
          if (table.__name === "users") {
            return queryResult(
              state.users.filter((row) =>
                matchesCondition(row as Record<string, unknown>, cond),
              ) as unknown as Record<string, unknown>[],
              fields,
            );
          }
          return queryResult([], fields);
        },
      }),
    }),
  },
}));

const { sanitizeUserInput } = await import("../services/chat-security.js");
const { validatePipelineSecurity } = await import("../services/pipeline-security.js");
const { checkRateLimit } = await import("../services/security-monitor.js");

describe("builder security helpers", () => {
  beforeEach(() => {
    mock.restore();
    state = {
      sessions: [],
      messages: [],
      pipelines: [],
      users: [{ id: "user-1", plan: "free" }],
    };
  });

  it("preserves template variables and code blocks during sanitization", () => {
    const input = 'Use {{input.url}}\n```yaml\nsteps:\n  - id: fetch\n```';
    expect(sanitizeUserInput(input)).toBe(input);
  });

  it("rejects unsafe agent tools and parallel tool execution", () => {
    const result = validatePipelineSecurity(
      {
        name: "Unsafe",
        version: 1,
        steps: [
          {
            id: "s1",
            name: "Fetch",
            type: "llm",
            prompt: "Fetch",
            agent: {
              allow_parallel_tools: true,
              tools: [{ type: "js", name: "run_script", js_source: "() => 1" }],
            },
          },
        ],
        output: { from: "s1" },
      },
      "user-1",
      "free",
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Parallel agent tools are not supported in this runtime");
    expect(result.errors).toContain('Agent tool type "js" is not allowed');
  });

  it("counts message rate limits across a user's sessions", async () => {
    const now = new Date();
    state.sessions = [
      { id: "session-a", userId: "user-1" },
      { id: "session-b", userId: "user-1" },
    ];
    state.messages = Array.from({ length: 50 }, (_, index) => ({
      sessionId: index < 25 ? "session-a" : "session-b",
      createdAt: new Date(now.getTime() - 1_000),
    }));

    const result = await checkRateLimit("user-1", "message");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeInstanceOf(Date);
  });

  it("counts pipeline creation limits per user", async () => {
    const now = new Date();
    state.pipelines = Array.from({ length: 10 }, () => ({
      userId: "user-1",
      createdAt: new Date(now.getTime() - 1_000),
    }));

    const result = await checkRateLimit("user-1", "pipeline_create");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
