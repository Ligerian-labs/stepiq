import { describe, expect, it } from "bun:test";
import Handlebars from "handlebars";

// Test the interpolation logic (extracted from executor)
function interpolate(
  template: string,
  context: Record<string, unknown>,
): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(context);
}

describe("interpolate (Handlebars template engine)", () => {
  it("interpolates simple variables", () => {
    const result = interpolate("Hello {{name}}", { name: "World" });
    expect(result).toBe("Hello World");
  });

  it("interpolates nested variables", () => {
    const result = interpolate("Topic: {{vars.topic}}", {
      vars: { topic: "AI trends" },
    });
    expect(result).toBe("Topic: AI trends");
  });

  it("supports legacy variables namespace", () => {
    const result = interpolate("Topic: {{variables.topic}}", {
      variables: { topic: "AI trends" },
    });
    expect(result).toBe("Topic: AI trends");
  });

  it("interpolates step outputs", () => {
    const result = interpolate("Previous: {{steps.research.output}}", {
      steps: { research: { output: "AI is growing" } },
    });
    expect(result).toBe("Previous: AI is growing");
  });

  it("handles missing variables gracefully", () => {
    const result = interpolate("Hello {{missing}}", {});
    expect(result).toBe("Hello ");
  });

  it("does not escape HTML (noEscape mode)", () => {
    const result = interpolate("{{content}}", {
      content: '<script>alert("xss")</script>',
    });
    expect(result).toBe('<script>alert("xss")</script>');
  });

  it("handles complex nested context", () => {
    const context = {
      input: { url: "https://example.com" },
      vars: { language: "fr", tone: "direct" },
      steps: {
        research: { output: { topics: ["AI", "ML"] } },
      },
    };
    const result = interpolate(
      "Write in {{vars.language}} about {{input.url}}",
      context,
    );
    expect(result).toBe("Write in fr about https://example.com");
  });

  it("handles conditionals", () => {
    const result = interpolate("{{#if active}}Active{{else}}Inactive{{/if}}", {
      active: true,
    });
    expect(result).toBe("Active");
  });

  it("handles iteration", () => {
    const result = interpolate("{{#each items}}{{this}} {{/each}}", {
      items: ["a", "b", "c"],
    });
    expect(result).toBe("a b c ");
  });
});

describe("cost calculation logic", () => {
  function calculateCost(
    inputTokens: number,
    outputTokens: number,
    inputCostPerMillion: number,
    outputCostPerMillion: number,
    markupPercentage: number,
  ): number {
    const inputCost = (inputTokens / 1_000_000) * inputCostPerMillion;
    const outputCost = (outputTokens / 1_000_000) * outputCostPerMillion;
    const baseCost = inputCost + outputCost;
    const withMarkup = baseCost * (1 + markupPercentage / 100);
    return Math.ceil(withMarkup);
  }

  it("calculates GPT-4o mini cost correctly", () => {
    const cost = calculateCost(1000, 500, 150, 600, 25);
    expect(cost).toBe(1);
  });

  it("calculates Claude Sonnet cost correctly", () => {
    const cost = calculateCost(5000, 2000, 3000, 15000, 25);
    expect(cost).toBe(57);
  });

  it("returns 0 for zero tokens", () => {
    const cost = calculateCost(0, 0, 3000, 15000, 25);
    expect(cost).toBe(0);
  });
});
