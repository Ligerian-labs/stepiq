import { beforeEach, describe, expect, it, mock } from "bun:test";

const tables = {
  users: {
    __name: "users",
    id: "users.id",
    plan: "users.plan",
    creditsRemaining: "users.creditsRemaining",
  },
  pipelines: { __name: "pipelines", id: "pipelines.id" },
  schedules: { __name: "schedules", id: "schedules.id" },
  runs: { __name: "runs", id: "runs.id" },
  pipelineVersions: {
    __name: "pipelineVersions",
    pipelineId: "pipelineVersions.pipelineId",
    version: "pipelineVersions.version",
  },
  stepExecutions: { __name: "stepExecutions", id: "stepExecutions.id" },
  stepTraceEvents: { __name: "stepTraceEvents", id: "stepTraceEvents.id" },
  userSecrets: {
    __name: "userSecrets",
    userId: "userSecrets.userId",
    pipelineId: "userSecrets.pipelineId",
    name: "userSecrets.name",
    encryptedValue: "userSecrets.encryptedValue",
  },
};

type StepExecRow = {
  id: string;
  runId: string;
  stepId: string;
  status: string;
  promptSent?: string;
  rawOutput?: string;
  parsedOutput?: unknown;
  error?: string;
};

type TestState = {
  run: Record<string, unknown> | null;
  user: { id: string; plan: string; creditsRemaining: number } | null;
  definition: Record<string, unknown> | null;
  userSecrets: Array<{
    name: string;
    encryptedValue: string;
    pipelineId?: string | null;
  }>;
  stepExecutions: StepExecRow[];
  stepTraceEvents: Array<Record<string, unknown>>;
  lastAgentRequest: Record<string, unknown> | null;
  runAgentRuntimeImpl: (req: Record<string, unknown>) => Promise<{
    output: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    tool_calls_total: number;
    tool_calls_success: number;
    tool_calls_failed: number;
    turns_used: number;
    trace: unknown;
  }>;
  lastModelRequest: Record<string, unknown> | null;
  callModelImpl: (req: Record<string, unknown>) => Promise<{
    output: string;
    input_tokens: number;
    output_tokens: number;
    cost_cents: number;
  }>;
};

let state: TestState;
let kmsShouldFail = false;

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

function createDbMock() {
  return {
    select: () => ({
      from: (table: { __name: string }) => ({
        where: (_cond: unknown) => {
          if (table.__name === "users") {
            return {
              limit: async (_n: number) => (state.user ? [state.user] : []),
            };
          }
          if (table.__name === "userSecrets") {
            return Promise.resolve(state.userSecrets);
          }
          return {
            limit: async (_n: number) => {
              if (table.__name === "runs") return state.run ? [state.run] : [];
              if (table.__name === "pipelineVersions") {
                return state.definition
                  ? [{ definition: state.definition }]
                  : [];
              }
              return [];
            },
          };
        },
      }),
    }),
    insert: (table: { __name: string }) => ({
      values: (values: Record<string, unknown>) => {
        if (table.__name === "stepTraceEvents") {
          state.stepTraceEvents.push(values);
          return Promise.resolve([]);
        }
        return {
          returning: async () => {
            if (table.__name !== "stepExecutions") return [];
            const row: StepExecRow = {
              id: `se-${state.stepExecutions.length + 1}`,
              runId: String(values.runId),
              stepId: String(values.stepId),
              status: String(values.status),
            };
            state.stepExecutions.push(row);
            return [row];
          },
        };
      },
    }),
    update: (table: { __name: string; id?: string }) => ({
      set: (setValues: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          if (table.__name === "runs" && state.run) {
            state.run = { ...state.run, ...setValues };
            return [state.run];
          }
          if (table.__name === "stepExecutions") {
            const id = getEqValue(cond, tables.stepExecutions.id);
            if (!id) return [];
            const index = state.stepExecutions.findIndex(
              (row) => row.id === id,
            );
            if (index < 0) return [];
            state.stepExecutions[index] = {
              ...state.stepExecutions[index],
              ...setValues,
            };
            return [state.stepExecutions[index]];
          }
          if (table.__name === "users" && state.user) {
            state.user = {
              ...state.user,
              ...(typeof setValues.creditsRemaining === "number"
                ? { creditsRemaining: setValues.creditsRemaining }
                : {}),
            };
            return [state.user];
          }
          return [];
        },
      }),
    }),
  };
}

mock.module("../db-executor.js", () => tables);
mock.module("postgres", () => ({ default: () => ({}) }));
mock.module("drizzle-orm/postgres-js", () => ({
  drizzle: () => createDbMock(),
}));
mock.module("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ type: "and", conds }),
  eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
  inArray: (left: unknown, right: unknown[]) => ({
    type: "inArray",
    left,
    right,
  }),
  isNull: (left: unknown) => ({ type: "isNull", left }),
  or: (...conds: unknown[]) => ({ type: "or", conds }),
}));
mock.module("../model-router.js", () => ({
  callModel: (req: Record<string, unknown>) => {
    state.lastModelRequest = req;
    return state.callModelImpl(req);
  },
}));
mock.module("../agent-runtime/runtime.js", () => ({
  runAgentRuntime: (req: Record<string, unknown>) => {
    state.lastAgentRequest = req;
    return state.runAgentRuntimeImpl(req);
  },
}));
mock.module("../core-adapter.js", () => ({
  PLAN_LIMITS: {
    free: { overage_per_credit_cents: 0 },
    starter: { overage_per_credit_cents: 1 },
    pro: { overage_per_credit_cents: 0.8 },
    enterprise: { overage_per_credit_cents: 0 },
  },
  MARKUP_PERCENTAGE: 25,
  SAFE_AGENT_TOOL_TYPES: [
    "http_request",
    "extract_json",
    "template_render",
    "curl",
  ],
  SUPPORTED_MODELS: [
    {
      id: "gpt-5.2",
      input_cost_per_million: 1750,
      output_cost_per_million: 14000,
    },
    {
      id: "gpt-4o-mini",
      input_cost_per_million: 150,
      output_cost_per_million: 600,
    },
  ],
  TOKENS_PER_CREDIT: 1000,
  providerSecretNames: (provider: string) => {
    if (provider === "openai") return ["OPENAI_API_KEY", "openai_api_key"];
    if (provider === "anthropic")
      return ["ANTHROPIC_API_KEY", "anthropic_api_key"];
    if (provider === "google")
      return [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "gemini_api_key",
        "google_api_key",
      ];
    if (provider === "mistral") return ["MISTRAL_API_KEY", "mistral_api_key"];
    if (provider === "zai") return ["ZAI_API_KEY", "zai_api_key"];
    return [];
  },
  createKmsProvider: () => ({
    getMasterKey: async () => {
      if (kmsShouldFail) {
        throw new Error("missing worker master key");
      }
      return Buffer.alloc(32, 1);
    },
  }),
  decryptSecret: async (_userId: string, blob: Buffer) => {
    const raw = blob.toString("utf8");
    if (raw === "global-openai") return "global-openai-value";
    if (raw === "pipeline-openai") return "pipeline-openai-value";
    return "super-secret-value";
  },
  redactSecrets: (text: string, secrets: string[]) =>
    secrets.reduce((acc, secret) => acc.split(secret).join("[REDACTED]"), text),
}));

const { executePipeline } = await import("../executor.js");

describe("executePipeline runtime behavior", () => {
  beforeEach(() => {
    kmsShouldFail = false;
    state = {
      run: {
        id: "run-1",
        userId: "user-1",
        pipelineId: "pipe-1",
        pipelineVersion: 1,
        inputData: { topic: "AI" },
        status: "pending",
      },
      user: {
        id: "user-1",
        plan: "free",
        creditsRemaining: 10,
      },
      definition: {
        name: "Test pipeline",
        version: 1,
        steps: [
          {
            id: "s1",
            type: "llm",
            model: "gpt-4o-mini",
            prompt: "Secret {{env.API_KEY}}",
          },
          {
            id: "s2",
            type: "transform",
            prompt: "Second {{steps.s1.output}}",
          },
        ],
        output: { from: "s2" },
      },
      userSecrets: [
        {
          name: "API_KEY",
          encryptedValue: Buffer.from("encrypted").toString("base64"),
        },
      ],
      stepExecutions: [],
      stepTraceEvents: [],
      lastAgentRequest: null,
      runAgentRuntimeImpl: async () => {
        throw new Error("agent runtime unavailable");
      },
      lastModelRequest: null,
      callModelImpl: async () => ({
        output: "model-output",
        input_tokens: 100,
        output_tokens: 40,
        cost_cents: 3,
      }),
    };
  });

  it("completes a run and persists step execution details", async () => {
    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.run?.totalTokens).toBe(140);
    expect(state.run?.totalCostCents).toBe(3);
    expect(state.run?.outputData).toBe("Second model-output");
    expect(state.user?.creditsRemaining).toBe(9);

    expect(state.stepExecutions).toHaveLength(2);
    expect(state.stepTraceEvents.length).toBeGreaterThan(0);
    expect(state.stepExecutions[0]?.status).toBe("completed");
    expect(state.stepExecutions[1]?.status).toBe("completed");
    expect(state.stepExecutions[0]?.promptSent).not.toContain(
      "super-secret-value",
    );
    expect(state.stepExecutions[0]?.promptSent).toContain("[REDACTED]");
  });

  it("resolves step output through 1-based numeric alias", async () => {
    state.definition = {
      name: "Numeric alias pipeline",
      version: 1,
      steps: [
        {
          id: "step_1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "First prompt",
        },
        {
          id: "step_2",
          type: "transform",
          prompt: "Second {{steps.1.output}}",
        },
      ],
      output: { from: "step_2" },
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.run?.outputData).toBe("Second model-output");
  });

  it("resolves step output through 0-based numeric alias", async () => {
    state.definition = {
      name: "Numeric zero alias pipeline",
      version: 1,
      steps: [
        {
          id: "step_1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "First prompt",
        },
        {
          id: "step_2",
          type: "transform",
          prompt: "Second {{steps.0.output}}",
        },
      ],
      output: { from: "step_2" },
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.run?.outputData).toBe("Second model-output");
  });

  it("fails run and marks step failed when model call throws", async () => {
    state.callModelImpl = async () => {
      throw new Error("provider error with super-secret-value");
    };
    state.definition = {
      name: "Failure pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Use {{env.API_KEY}}",
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    expect(String(state.run?.error || "")).toContain('Step "s1" failed');
    expect(String(state.run?.error || "")).not.toContain("super-secret-value");
    expect(state.stepExecutions).toHaveLength(1);
    expect(state.stepExecutions[0]?.status).toBe("failed");
    expect(String(state.stepExecutions[0]?.error || "")).toContain(
      "[REDACTED]",
    );
  });

  it("salvages successful tool output when agent runtime times out after tool activity", async () => {
    state.definition = {
      name: "Agent timeout pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Fetch and summarize",
        },
      ],
    };
    state.runAgentRuntimeImpl = async (req) => {
      const onLog =
        typeof req.on_log === "function"
          ? (req.on_log as (entry: Record<string, unknown>) => void)
          : null;
      onLog?.({
        ts: new Date().toISOString(),
        level: "info",
        source: "tool_bridge",
        event: "tool_call_completed",
        message: "Tool call completed",
        data: {
          tool: "fetch_page",
          status: 200,
          result: { ok: true, status: 200, body: "<html>ok</html>" },
        },
      });
      throw new Error("provider_error: context deadline exceeded");
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.lastModelRequest).toBeNull();
    expect(state.stepExecutions).toHaveLength(1);
    expect(state.stepExecutions[0]?.status).toBe("completed");
    expect(state.stepExecutions[0]?.parsedOutput).toEqual({
      ok: true,
      status: 200,
      body: "<html>ok</html>",
    });
    expect(
      state.stepTraceEvents.some(
        (event) => event.kind === "tool.result.completed",
      ),
    ).toBe(true);
    expect(state.run?.outputData).toEqual({
      ok: true,
      status: 200,
      body: "<html>ok</html>",
    });
  });

  it("falls back to direct model call when agent runtime fails early without timeout or tool activity", async () => {
    state.definition = {
      name: "Early agent failure pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Simple prompt",
        },
      ],
    };
    state.runAgentRuntimeImpl = async () => {
      throw new Error("temporary runtime bootstrap error");
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.stepExecutions).toHaveLength(1);
    expect(state.stepExecutions[0]?.status).toBe("completed");
    expect(
      state.stepTraceEvents.some((event) => event.kind === "fallback.started"),
    ).toBe(true);
    expect(
      state.stepTraceEvents.some(
        (event) => event.kind === "fallback.completed",
      ),
    ).toBe(true);
    expect(state.lastModelRequest).not.toBeNull();
  });

  it("fails step on timeout when no successful tool result can be salvaged", async () => {
    state.definition = {
      name: "Timeout without successful tool result pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Simple prompt",
        },
      ],
    };
    state.runAgentRuntimeImpl = async (req) => {
      const onLog =
        typeof req.on_log === "function"
          ? (req.on_log as (entry: Record<string, unknown>) => void)
          : null;
      onLog?.({
        ts: new Date().toISOString(),
        level: "error",
        source: "tool_bridge",
        event: "tool_call_failed",
        message: "Tool call failed",
        data: { tool: "fetch_page", error: "upstream 500" },
      });
      throw new Error("provider_error: context deadline exceeded");
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    expect(String(state.run?.error || "")).toContain('Step "s1" failed');
    expect(state.lastModelRequest).toBeNull();
    expect(state.stepExecutions).toHaveLength(1);
    expect(state.stepExecutions[0]?.status).toBe("failed");
  });

  it("fails runs that use unsupported agent tool types", async () => {
    state.definition = {
      name: "Unsafe tool pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Do work",
          agent: {
            tools: [{ type: "js", name: "run_script", js_source: "() => 1" }],
          },
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    expect(String(state.run?.error || "")).toContain("Unsupported agent tool types");
  });

  it("fails runs that request parallel tools", async () => {
    state.definition = {
      name: "Parallel tool pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Do work",
          agent: {
            allow_parallel_tools: true,
            tools: [{ type: "http_request", name: "fetch_page" }],
          },
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    expect(String(state.run?.error || "")).toContain(
      "allow_parallel_tools is not supported",
    );
  });

  it("throws when run is missing", async () => {
    state.run = null;
    await expect(executePipeline("missing-run")).rejects.toThrow(
      "Run missing-run not found",
    );
  });

  it("passes provider API keys from saved secrets to model calls", async () => {
    state.definition = {
      name: "Provider key pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-5.2",
          prompt: "No env refs in prompt",
        },
      ],
    };
    state.userSecrets = [
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("encrypted").toString("base64"),
      },
      {
        name: "GEMINI_API_KEY",
        encryptedValue: Buffer.from("encrypted-gemini").toString("base64"),
      },
      {
        name: "MISTRAL_API_KEY",
        encryptedValue: Buffer.from("encrypted-mistral").toString("base64"),
      },
    ];

    await executePipeline("run-1");

    const apiKeys = (state.lastModelRequest?.api_keys || {}) as Record<
      string,
      string
    >;
    expect(apiKeys.openai).toBe("super-secret-value");
    expect(apiKeys.gemini).toBe("super-secret-value");
    expect(apiKeys.mistral).toBe("super-secret-value");
  });

  it("fails run with explicit KMS error when secrets cannot be decrypted", async () => {
    kmsShouldFail = true;
    state.definition = {
      name: "Provider key pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-5.2",
          prompt: "No env refs in prompt",
        },
      ],
    };
    state.userSecrets = [
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("encrypted").toString("base64"),
      },
    ];

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    const errorText = String(state.run?.error || "");
    expect(errorText).toContain("Worker cannot decrypt secrets");
    expect(errorText).toContain("STEPIQ_MASTER_KEY");
    expect(errorText).not.toContain("OpenAI API key is missing");
    expect(state.lastModelRequest).toBeNull();
  });

  it("prefers pipeline-scoped secrets over global secrets with the same name", async () => {
    state.definition = {
      name: "Pipeline overrides global",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-5.2",
          prompt: "No env refs in prompt",
        },
      ],
    };
    state.userSecrets = [
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("global-openai").toString("base64"),
      },
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("pipeline-openai").toString("base64"),
        pipelineId: "pipe-1",
      },
    ];

    await executePipeline("run-1");

    const apiKeys = (state.lastModelRequest?.api_keys || {}) as Record<
      string,
      string
    >;
    expect(apiKeys.openai).toBe("pipeline-openai-value");
  });

  it("uses app funding mode with env keys and deducts cost-based credits", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "platform-openai-key";
    state.run = {
      ...(state.run || {}),
      fundingMode: "app_credits",
    };
    state.user = {
      id: "user-1",
      plan: "starter",
      creditsRemaining: 10,
    };
    state.definition = {
      name: "App-funded pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Hello",
        },
      ],
    };
    state.userSecrets = [
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("encrypted").toString("base64"),
      },
    ];
    state.callModelImpl = async () => ({
      output: "ok",
      input_tokens: 100,
      output_tokens: 20,
      cost_cents: 5,
    });

    try {
      await executePipeline("run-1");

      const apiKeys = (state.lastModelRequest?.api_keys || {}) as Record<
        string,
        string
      >;
      expect(apiKeys.openai).toBe("platform-openai-key");
      expect(state.user?.creditsRemaining).toBe(5);
      expect(state.run?.creditsDeducted).toBe(5);
    } finally {
      if (previousOpenAiApiKey === undefined) {
        process.env.OPENAI_API_KEY = undefined;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey;
      }
    }
  });

  it("does not deduct credits when run is BYOK funded", async () => {
    state.run = {
      ...(state.run || {}),
      fundingMode: "byok_required",
    };
    state.user = {
      id: "user-1",
      plan: "starter",
      creditsRemaining: 10,
    };
    state.definition = {
      name: "BYOK funded pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Hello",
        },
      ],
    };
    state.userSecrets = [
      {
        name: "OPENAI_API_KEY",
        encryptedValue: Buffer.from("encrypted").toString("base64"),
      },
    ];
    state.callModelImpl = async () => ({
      output: "ok",
      input_tokens: 2000,
      output_tokens: 500,
      cost_cents: 8,
    });

    await executePipeline("run-1");

    expect(state.user?.creditsRemaining).toBe(10);
    expect(state.run?.creditsDeducted).toBe(0);
  });

  it("deducts credits based on total tokens with round-up", async () => {
    state.callModelImpl = async () => ({
      output: "model-output",
      input_tokens: 1999,
      output_tokens: 0,
      cost_cents: 5,
    });
    state.definition = {
      name: "Credit rounding pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Hello",
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.run?.totalTokens).toBe(1999);
    expect(state.user?.creditsRemaining).toBe(8);
  });

  it("does not let credit balance go below zero", async () => {
    state.user = {
      id: "user-1",
      plan: "starter",
      creditsRemaining: 1,
    };
    state.callModelImpl = async () => ({
      output: "model-output",
      input_tokens: 2500,
      output_tokens: 0,
      cost_cents: 5,
    });
    state.definition = {
      name: "Credit floor pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Hello",
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("completed");
    expect(state.user?.creditsRemaining).toBe(0);
  });

  it("deducts credits for failed runs that consumed tokens", async () => {
    let calls = 0;
    state.callModelImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          output: "first-output",
          input_tokens: 1200,
          output_tokens: 100,
          cost_cents: 2,
        };
      }
      throw new Error("provider error");
    };
    state.definition = {
      name: "Partial failure pipeline",
      version: 1,
      steps: [
        {
          id: "s1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "First",
        },
        {
          id: "s2",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Second",
        },
      ],
    };

    await executePipeline("run-1");

    expect(state.run?.status).toBe("failed");
    expect(state.run?.totalTokens).toBe(1300);
    expect(state.user?.creditsRemaining).toBe(8);
  });
});
