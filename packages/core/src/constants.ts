import type { ModelInfo, Plan } from "./types";

export const SUPPORTED_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    input_cost_per_million: 5_000, // $5.00
    output_cost_per_million: 25_000, // $25.00
    max_tokens: 8192,
    supports_json: true,
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    input_cost_per_million: 1_750, // $1.75
    output_cost_per_million: 14_000, // $14.00
    max_tokens: 128000,
    supports_json: true,
  },
  {
    id: "gpt-5.2-chat-latest",
    name: "GPT-5.2 Instant",
    provider: "openai",
    input_cost_per_million: 1_750, // $1.75
    output_cost_per_million: 14_000, // $14.00
    max_tokens: 128000,
    supports_json: true,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3-Codex",
    provider: "openai",
    input_cost_per_million: 1_750, // $1.75
    output_cost_per_million: 14_000, // $14.00
    max_tokens: 128000,
    supports_json: true,
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    input_cost_per_million: 3_000, // $3.00
    output_cost_per_million: 15_000, // $15.00
    max_tokens: 8192,
    supports_json: true,
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude Haiku 3.5",
    provider: "anthropic",
    input_cost_per_million: 250, // $0.25
    output_cost_per_million: 1_250, // $1.25
    max_tokens: 8192,
    supports_json: true,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    input_cost_per_million: 2_500, // $2.50
    output_cost_per_million: 10_000, // $10.00
    max_tokens: 16384,
    supports_json: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    input_cost_per_million: 150, // $0.15
    output_cost_per_million: 600, // $0.60
    max_tokens: 16384,
    supports_json: true,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    input_cost_per_million: 1_250, // $1.25
    output_cost_per_million: 10_000, // $10.00
    max_tokens: 65536,
    supports_json: true,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    input_cost_per_million: 300, // $0.30
    output_cost_per_million: 2_500, // $2.50
    max_tokens: 65536,
    supports_json: true,
  },
  {
    id: "glm-5",
    name: "GLM-5",
    provider: "zai",
    input_cost_per_million: 20, // $0.02
    output_cost_per_million: 110, // $0.11
    max_tokens: 128000,
    supports_json: true,
  },
  {
    id: "glm-4.6",
    name: "GLM-4.6",
    provider: "zai",
    input_cost_per_million: 80, // $0.08
    output_cost_per_million: 200, // $0.20
    max_tokens: 128000,
    supports_json: true,
  },
  {
    id: "mistral-large-latest",
    name: "Mistral Large Latest",
    provider: "mistral",
    input_cost_per_million: 2_000, // $2.00
    output_cost_per_million: 6_000, // $6.00
    max_tokens: 32000,
    supports_json: true,
  },
  {
    id: "mistral-small-latest",
    name: "Mistral Small Latest",
    provider: "mistral",
    input_cost_per_million: 200, // $0.20
    output_cost_per_million: 600, // $0.60
    max_tokens: 32000,
    supports_json: true,
  },
];

export const MARKUP_PERCENTAGE = 25; // 25% markup on model costs
export const YEARLY_DISCOUNT_PERCENT = 10;

export const PLAN_LIMITS: Record<
  Plan,
  {
    credits: number;
    max_runs_per_day: number;
    max_pipelines: number;
    max_steps_per_pipeline: number;
    agent_max_turns: number;
    agent_max_duration_seconds: number;
    agent_max_tool_calls: number;
    agent_tool_fee_cents: number;
    credit_value_cents: number;
    cron_enabled: boolean;
    webhooks_enabled: boolean;
    api_enabled: boolean;
    price_cents: number; // monthly price in cents
    overage_per_credit_cents: number;
  }
> = {
  free: {
    credits: 100,
    max_runs_per_day: 10,
    max_pipelines: 3,
    max_steps_per_pipeline: 5,
    agent_max_turns: 3,
    agent_max_duration_seconds: 120,
    agent_max_tool_calls: 1,
    agent_tool_fee_cents: 3,
    credit_value_cents: 1,
    cron_enabled: false,
    webhooks_enabled: false,
    api_enabled: false,
    price_cents: 0,
    overage_per_credit_cents: 0, // no overage, hard limit
  },
  starter: {
    credits: 2_000,
    max_runs_per_day: 100,
    max_pipelines: 10,
    max_steps_per_pipeline: 10,
    agent_max_turns: 8,
    agent_max_duration_seconds: 180,
    agent_max_tool_calls: 3,
    agent_tool_fee_cents: 2,
    credit_value_cents: 1,
    cron_enabled: true,
    webhooks_enabled: true,
    api_enabled: true,
    price_cents: 1_900, // €19
    overage_per_credit_cents: 1, // €0.01/credit
  },
  pro: {
    credits: 8_000,
    max_runs_per_day: 500,
    max_pipelines: -1, // unlimited
    max_steps_per_pipeline: 20,
    agent_max_turns: 20,
    agent_max_duration_seconds: 240,
    agent_max_tool_calls: 10,
    agent_tool_fee_cents: 1,
    credit_value_cents: 0.8,
    cron_enabled: true,
    webhooks_enabled: true,
    api_enabled: true,
    price_cents: 4_900, // €49
    overage_per_credit_cents: 0.8, // €0.008/credit
  },
  enterprise: {
    credits: -1, // custom
    max_runs_per_day: -1,
    max_pipelines: -1,
    max_steps_per_pipeline: 50,
    agent_max_turns: 20,
    agent_max_duration_seconds: 500,
    agent_max_tool_calls: 10,
    agent_tool_fee_cents: 0,
    credit_value_cents: 0.8,
    cron_enabled: true,
    webhooks_enabled: true,
    api_enabled: true,
    price_cents: 0, // custom
    overage_per_credit_cents: 0,
  },
};

export function getYearlyPriceCents(monthlyPriceCents: number): number {
  const discounted =
    monthlyPriceCents * 12 * (1 - YEARLY_DISCOUNT_PERCENT / 100);
  // Round to whole-euro cents (e.g. 20520 -> 20500)
  return Math.round(discounted / 100) * 100;
}

export const PLAN_BILLING_PRICES = {
  starter: {
    monthly_cents: PLAN_LIMITS.starter.price_cents,
    yearly_cents: getYearlyPriceCents(PLAN_LIMITS.starter.price_cents),
  },
  pro: {
    monthly_cents: PLAN_LIMITS.pro.price_cents,
    yearly_cents: getYearlyPriceCents(PLAN_LIMITS.pro.price_cents),
  },
} as const;

// 1 credit ≈ 1,000 tokens
export const TOKENS_PER_CREDIT = 1_000;
