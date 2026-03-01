import { describe, expect, it } from "bun:test";
import {
  getYearlyPriceCents,
  MARKUP_PERCENTAGE,
  PLAN_BILLING_PRICES,
  PLAN_LIMITS,
  SUPPORTED_MODELS,
  TOKENS_PER_CREDIT,
  YEARLY_DISCOUNT_PERCENT,
} from "../constants.js";

describe("SUPPORTED_MODELS", () => {
  it("contains at least one model", () => {
    expect(SUPPORTED_MODELS.length).toBeGreaterThan(0);
  });

  it("each model has required fields", () => {
    for (const m of SUPPORTED_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.provider).toBeTruthy();
      expect(m.input_cost_per_million).toBeGreaterThan(0);
      expect(m.output_cost_per_million).toBeGreaterThan(0);
      expect(m.max_tokens).toBeGreaterThan(0);
    }
  });

  it("includes supported providers", () => {
    const providers = new Set(SUPPORTED_MODELS.map((m) => m.provider));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("mistral")).toBe(true);
  });

  it("has unique model IDs", () => {
    const ids = SUPPORTED_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses provider-specific model id prefixes", () => {
    for (const model of SUPPORTED_MODELS) {
      if (model.provider === "anthropic") {
        expect(model.id.startsWith("claude-")).toBe(true);
      }
      if (model.provider === "openai") {
        expect(model.id.startsWith("gpt-")).toBe(true);
      }
      if (model.provider === "google") {
        expect(model.id.startsWith("gemini-")).toBe(true);
      }
      if (model.provider === "mistral") {
        expect(model.id.startsWith("mistral-")).toBe(true);
      }
    }
  });
});

describe("PLAN_LIMITS", () => {
  it("has all plans defined", () => {
    expect(PLAN_LIMITS.free).toBeDefined();
    expect(PLAN_LIMITS.starter).toBeDefined();
    expect(PLAN_LIMITS.pro).toBeDefined();
    expect(PLAN_LIMITS.enterprise).toBeDefined();
  });

  it("free plan has correct limits", () => {
    const free = PLAN_LIMITS.free;
    expect(free.credits).toBe(100);
    expect(free.max_runs_per_day).toBe(10);
    expect(free.max_pipelines).toBe(3);
    expect(free.cron_enabled).toBe(false);
    expect(free.price_cents).toBe(0);
  });

  it("webhook availability matches plan tiers", () => {
    expect(PLAN_LIMITS.free.webhooks_enabled).toBe(false);
    expect(PLAN_LIMITS.starter.webhooks_enabled).toBe(true);
    expect(PLAN_LIMITS.pro.webhooks_enabled).toBe(true);
  });

  it("connector step availability matches plan tiers", () => {
    expect(PLAN_LIMITS.free.connectors_enabled).toBe(false);
    expect(PLAN_LIMITS.starter.connectors_enabled).toBe(false);
    expect(PLAN_LIMITS.pro.connectors_enabled).toBe(true);
    expect(PLAN_LIMITS.enterprise.connectors_enabled).toBe(true);
  });

  it("pro plan costs €49", () => {
    expect(PLAN_LIMITS.pro.price_cents).toBe(4900);
    expect(PLAN_LIMITS.pro.credits).toBe(8000);
  });

  it("enterprise has unlimited pipelines", () => {
    expect(PLAN_LIMITS.enterprise.max_pipelines).toBe(-1);
  });
});

describe("constants", () => {
  it("MARKUP_PERCENTAGE is 25%", () => {
    expect(MARKUP_PERCENTAGE).toBe(25);
  });

  it("TOKENS_PER_CREDIT is 1000", () => {
    expect(TOKENS_PER_CREDIT).toBe(1000);
  });

  it("YEARLY_DISCOUNT_PERCENT is 10%", () => {
    expect(YEARLY_DISCOUNT_PERCENT).toBe(10);
  });

  it("computes yearly plan prices with discount and whole-euro rounding", () => {
    expect(getYearlyPriceCents(1900)).toBe(20500);
    expect(getYearlyPriceCents(4900)).toBe(52900);
    expect(PLAN_BILLING_PRICES.starter.yearly_cents).toBe(20500);
    expect(PLAN_BILLING_PRICES.pro.yearly_cents).toBe(52900);
  });
});
