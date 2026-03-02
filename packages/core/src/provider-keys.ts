import type { PipelineDefinition } from "./types";
import { SUPPORTED_MODELS } from "./constants";

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "zai";

const PROVIDER_SECRET_NAMES: Record<ModelProvider, string[]> = {
  openai: ["OPENAI_API_KEY", "openai_api_key"],
  anthropic: ["ANTHROPIC_API_KEY", "anthropic_api_key"],
  google: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "gemini_api_key",
    "google_api_key",
  ],
  mistral: ["MISTRAL_API_KEY", "mistral_api_key"],
  zai: ["ZAI_API_KEY", "zai_api_key"],
};

export function providerSecretNames(provider: ModelProvider): string[] {
  return PROVIDER_SECRET_NAMES[provider];
}

export function providerForModel(model: string): ModelProvider | null {
  const normalized = model.trim().toLowerCase();
  const match = SUPPORTED_MODELS.find(
    (item) => item.id.toLowerCase() === normalized,
  );
  if (!match) return null;
  if (
    match.provider === "openai" ||
    match.provider === "anthropic" ||
    match.provider === "google" ||
    match.provider === "mistral" ||
    match.provider === "zai"
  ) {
    return match.provider;
  }
  return null;
}

export function providersForPipeline(
  definition: PipelineDefinition,
): ModelProvider[] {
  const providers = new Set<ModelProvider>();
  for (const step of definition.steps || []) {
    if ((step.type || "llm") !== "llm") continue;
    const provider = providerForModel(step.model || "gpt-5.2");
    if (provider) providers.add(provider);
  }
  return Array.from(providers);
}
