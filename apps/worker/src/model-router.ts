import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import OpenAI from "openai";
import { bootstrapWorkerEnv } from "./env-bootstrap.js";
import { MARKUP_PERCENTAGE, SUPPORTED_MODELS } from "./core-adapter.js";

bootstrapWorkerEnv();

interface ModelRequest {
  model: string;
  prompt: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  output_format?: "text" | "json" | "markdown";
  api_keys?: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
    google?: string;
    mistral?: string;
    zai?: string;
  };
}

interface ModelResponse {
  output: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  model: string;
  latency_ms: number;
}

function isPlaceholderApiKey(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "placeholder" ||
    normalized === "your-api-key" ||
    normalized === "changeme"
  );
}

export async function callModel(req: ModelRequest): Promise<ModelResponse> {
  const normalized = req.model.trim().toLowerCase();
  const modelInfo = SUPPORTED_MODELS.find(
    (m: (typeof SUPPORTED_MODELS)[number]) => m.id.toLowerCase() === normalized,
  );
  if (!modelInfo) throw new Error(`Unsupported model: ${req.model}`);

  const start = Date.now();

  if (modelInfo.provider === "anthropic") {
    return callAnthropic(req, modelInfo, start);
  }
  if (modelInfo.provider === "openai") {
    return callOpenAI(req, modelInfo, start);
  }
  if (modelInfo.provider === "google") {
    return callGoogle(req, modelInfo, start);
  }
  if (modelInfo.provider === "mistral") {
    return callMistral(req, modelInfo, start);
  }
  if (modelInfo.provider === "zai") {
    return callZAI(req, modelInfo, start);
  }

  throw new Error(`Unsupported provider: ${modelInfo.provider}`);
}

async function callAnthropic(
  req: ModelRequest,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
  start: number,
): Promise<ModelResponse> {
  const apiKey = req.api_keys?.anthropic || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    throw new Error(
      "Anthropic API key is missing. Save ANTHROPIC_API_KEY in Settings → Secrets.",
    );
  }
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: modelInfo.id,
    max_tokens: req.max_tokens || 4096,
    temperature: req.temperature,
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
  });

  const output =
    response.content[0].type === "text" ? response.content[0].text : "";

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costCents = calculateCost(inputTokens, outputTokens, modelInfo);

  return {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    model: modelInfo.id,
    latency_ms: Date.now() - start,
  };
}

async function callOpenAI(
  req: ModelRequest,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
  start: number,
): Promise<ModelResponse> {
  const apiKey = req.api_keys?.openai || process.env.OPENAI_API_KEY || "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    throw new Error(
      "OpenAI API key is missing. Save OPENAI_API_KEY in Settings → Secrets.",
    );
  }
  const openai = new OpenAI({ apiKey });

  const isGpt5Family = modelInfo.id.toLowerCase().startsWith("gpt-5");
  const response = await openai.chat.completions.create({
    model: modelInfo.id,
    ...(isGpt5Family
      ? { max_completion_tokens: req.max_tokens || 4096 }
      : { max_tokens: req.max_tokens || 4096 }),
    temperature: req.temperature,
    messages: [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.prompt },
    ],
    ...(req.output_format === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
  });

  const output = response.choices[0]?.message?.content || "";
  const inputTokens = response.usage?.prompt_tokens || 0;
  const outputTokens = response.usage?.completion_tokens || 0;
  const costCents = calculateCost(inputTokens, outputTokens, modelInfo);

  return {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    model: modelInfo.id,
    latency_ms: Date.now() - start,
  };
}

async function callGoogle(
  req: ModelRequest,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
  start: number,
): Promise<ModelResponse> {
  const apiKey =
    req.api_keys?.gemini ||
    req.api_keys?.google ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    throw new Error(
      "Gemini API key is missing. Save GEMINI_API_KEY in Settings → Secrets.",
    );
  }
  const google = new GoogleGenAI({ apiKey });

  const response = await google.models.generateContent({
    model: modelInfo.id,
    contents: req.prompt,
    config: {
      ...(req.system ? { systemInstruction: req.system } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...(req.max_tokens ? { maxOutputTokens: req.max_tokens } : {}),
      ...(req.output_format === "json"
        ? { responseMimeType: "application/json" }
        : {}),
    },
  });

  const output = response.text || "";
  const inputTokens = response.usageMetadata?.promptTokenCount || 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
  const costCents = calculateCost(inputTokens, outputTokens, modelInfo);

  return {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    model: modelInfo.id,
    latency_ms: Date.now() - start,
  };
}

async function callZAI(
  req: ModelRequest,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
  start: number,
): Promise<ModelResponse> {
  const apiKey = req.api_keys?.zai || process.env.ZAI_API_KEY || "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    throw new Error(
      "z.ai API key is missing. Save ZAI_API_KEY in Settings → Secrets.",
    );
  }

  const baseURL =
    process.env.ZAI_BASE_URL?.trim() || "https://api.z.ai/api/paas/v4";
  const zai = new OpenAI({ apiKey, baseURL });

  const isGpt5Family = modelInfo.id.toLowerCase().startsWith("gpt-5");
  const response = await zai.chat.completions.create({
    model: modelInfo.id,
    ...(isGpt5Family
      ? { max_completion_tokens: req.max_tokens || 4096 }
      : { max_tokens: req.max_tokens || 4096 }),
    temperature: req.temperature,
    messages: [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.prompt },
    ],
    ...(req.output_format === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
  });

  const output = response.choices[0]?.message?.content || "";
  const inputTokens = response.usage?.prompt_tokens || 0;
  const outputTokens = response.usage?.completion_tokens || 0;
  const costCents = calculateCost(inputTokens, outputTokens, modelInfo);

  return {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    model: modelInfo.id,
    latency_ms: Date.now() - start,
  };
}

async function callMistral(
  req: ModelRequest,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
  start: number,
): Promise<ModelResponse> {
  const apiKey = req.api_keys?.mistral || process.env.MISTRAL_API_KEY || "";
  if (!apiKey || isPlaceholderApiKey(apiKey)) {
    throw new Error(
      "Mistral API key is missing. Save MISTRAL_API_KEY in Settings → Secrets.",
    );
  }
  const mistral = new Mistral({ apiKey });

  const response = await mistral.chat.complete({
    model: modelInfo.id,
    maxTokens: req.max_tokens || 4096,
    temperature: req.temperature,
    messages: [
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.prompt },
    ],
    ...(req.output_format === "json"
      ? { responseFormat: { type: "json_object" as const } }
      : {}),
  });

  const output = extractMistralText(response.choices[0]?.message?.content);
  const inputTokens = response.usage?.promptTokens || 0;
  const outputTokens = response.usage?.completionTokens || 0;
  const costCents = calculateCost(inputTokens, outputTokens, modelInfo);

  return {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: costCents,
    model: modelInfo.id,
    latency_ms: Date.now() - start,
  };
}

function extractMistralText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((chunk) => {
      if (
        chunk &&
        typeof chunk === "object" &&
        "type" in chunk &&
        "text" in chunk &&
        (chunk as { type?: string }).type === "text" &&
        typeof (chunk as { text?: unknown }).text === "string"
      ) {
        return (chunk as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  modelInfo: (typeof SUPPORTED_MODELS)[number],
): number {
  const inputCost =
    (inputTokens / 1_000_000) * modelInfo.input_cost_per_million;
  const outputCost =
    (outputTokens / 1_000_000) * modelInfo.output_cost_per_million;
  const baseCost = inputCost + outputCost;
  const withMarkup = baseCost * (1 + MARKUP_PERCENTAGE / 100);
  return Math.ceil(withMarkup); // cents
}
