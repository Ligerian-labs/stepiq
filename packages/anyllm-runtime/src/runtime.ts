import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export type AnyLLMProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "zai";

export interface AnyLLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AnyLLMAgentConfig {
  max_turns: number;
  max_duration_seconds: number;
  max_tool_calls: number;
  allow_parallel_tools?: boolean;
  tools?: unknown[];
  network_allowlist?: string[];
}

export interface AnyLLMAgentRequest {
  provider: AnyLLMProvider;
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  output_format?: "text" | "json" | "markdown";
  api_keys?: Record<string, string | undefined>;
  agent: AnyLLMAgentConfig;
}

export interface AnyLLMAgentResult {
  output: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turns_used: number;
  tool_calls_total: number;
  tool_calls_success: number;
  tool_calls_failed: number;
  trace: unknown[];
}

export interface AnyLLMCompletionRequest {
  provider: AnyLLMProvider;
  model: string;
  system?: string;
  prompt: string;
  output_format?: "text" | "json" | "markdown";
  temperature?: number;
  max_tokens?: number;
  api_keys?: Record<string, string | undefined>;
}

export interface AnyLLMCompletionResult {
  output: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turns_used: number;
}

type GoRuntimeGlobal = typeof globalThis & {
  Go?: new () => {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  };
  stepiqRunAgentStep?: (
    payloadJson: string,
  ) => Promise<string | { error: string }> | string | { error: string };
  stepiqCallTool?: (payloadJson: string) => Promise<string>;
  stepiqAgentLog?: (payloadJson: string) => void;
};

const here = dirname(fileURLToPath(import.meta.url));
const wasmExecPath = resolve(here, "./wasm_exec.js");
const wasmPath = resolve(here, "./agent.wasm");

let bootPromise: Promise<void> | null = null;
let initialized = false;

async function loadGoWasmRuntime() {
  if (initialized) return;
  if (!bootPromise) {
    bootPromise = (async () => {
      const g = globalThis as GoRuntimeGlobal;
      if (!g.Go) {
        const wasmExecCode = await readFile(wasmExecPath, "utf8");
        vm.runInThisContext(wasmExecCode, { filename: wasmExecPath });
      }
      if (!g.Go) throw new Error("Go WASM runtime did not expose global Go");

      const go = new g.Go();
      const wasmBytes = await readFile(wasmPath);
      const inst = await WebAssembly.instantiate(wasmBytes, go.importObject);
      go.run(inst.instance).catch((err: unknown) => {
        console.error("anyllm wasm runtime exited", err);
      });

      const start = Date.now();
      while (!g.stepiqRunAgentStep) {
        if (Date.now() - start > 10_000) {
          throw new Error("Timed out waiting for stepiqRunAgentStep");
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      initialized = true;
    })();
  }

  await bootPromise;
}

function buildApiKeys(apiKeys?: Record<string, string | undefined>) {
  return {
    openai: apiKeys?.openai,
    anthropic: apiKeys?.anthropic,
    google: apiKeys?.gemini || apiKeys?.google,
    gemini: apiKeys?.gemini || apiKeys?.google,
    mistral: apiKeys?.mistral,
    zai: apiKeys?.zai,
    zai_base_url: process.env.ZAI_BASE_URL,
  };
}

let wasmLock: Promise<void> = Promise.resolve();

function acquireWasmLock(): { promise: Promise<void>; release: () => void } {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = wasmLock;
  wasmLock = next;
  return { promise: prev, release: release! };
}

async function invokeRuntime<T>(
  payload: Record<string, unknown>,
  options?: {
    toolInvoker?: (payloadJson: string) => Promise<string>;
    agentLogger?: (payloadJson: string) => void;
  },
): Promise<T> {
  await loadGoWasmRuntime();
  const g = globalThis as GoRuntimeGlobal;

  const lock = acquireWasmLock();
  await lock.promise;

  try {
    if (options?.toolInvoker) {
      g.stepiqCallTool = options.toolInvoker;
    }
    if (options?.agentLogger) {
      g.stepiqAgentLog = options.agentLogger;
    }

    const resultRaw = await g.stepiqRunAgentStep?.(JSON.stringify(payload));
    if (!resultRaw) throw new Error("AnyLLM runtime did not return a value");
    if (typeof resultRaw === "object" && "error" in resultRaw) {
      throw new Error(String(resultRaw.error));
    }

    const parsed = JSON.parse(String(resultRaw)) as T & { error?: string };
    if (!parsed) throw new Error("AnyLLM runtime returned an empty response");
    if (parsed.error) throw new Error(parsed.error);

    return parsed;
  } finally {
    g.stepiqCallTool = undefined;
    g.stepiqAgentLog = undefined;
    lock.release();
  }
}

export async function runAnyLLMAgentStep(
  input: AnyLLMAgentRequest,
  options?: {
    toolInvoker?: (payloadJson: string) => Promise<string>;
    agentLogger?: (payloadJson: string) => void;
  },
): Promise<AnyLLMAgentResult> {
  const parsed = await invokeRuntime<AnyLLMAgentResult>(
    {
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      system: input.system,
      temperature: input.temperature,
      max_tokens: input.max_tokens,
      output_format: input.output_format,
      api_keys: buildApiKeys(input.api_keys),
      agent: input.agent,
    },
    options,
  );

  if (!parsed.output || !parsed.output.trim()) {
    throw new Error("AnyLLM runtime returned an empty response");
  }

  return parsed;
}

export async function runAnyLLMCompletion(
  input: AnyLLMCompletionRequest,
): Promise<AnyLLMCompletionResult> {
  const parsed = await invokeRuntime<AnyLLMCompletionResult>({
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    system: input.system,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
    output_format: input.output_format,
    api_keys: buildApiKeys(input.api_keys),
    agent: {
      max_turns: 1,
      max_duration_seconds: 45,
      max_tool_calls: 0,
      tools: [],
      network_allowlist: [],
    },
  });

  if (!parsed.output || !parsed.output.trim()) {
    throw new Error("AnyLLM runtime returned an empty response");
  }

  return parsed;
}
