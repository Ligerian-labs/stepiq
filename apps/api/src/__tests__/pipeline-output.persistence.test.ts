import { updatePipelineSchema } from "@stepiq/core";
import { describe, expect, it } from "bun:test";
import { validatePipelineSecurity } from "../services/pipeline-security.js";

type PipelineRow = {
  id: string;
  userId: string;
  name: string;
  description: string;
  status: string;
  version: number;
  definition: Record<string, unknown>;
};

describe("pipeline output webhook persistence", () => {
  it("preserves output.deliver webhook fields through validation and versioning", () => {
    const previousWebhookAllowlist =
      process.env.WHITELISTED_WEBHOOK_DOMAINS;
    process.env.WHITELISTED_WEBHOOK_DOMAINS = "hooks.example.com";
    const existing: PipelineRow = {
      id: "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4",
      userId: "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4",
      name: "test-pipeline",
      description: "test",
      status: "active",
      version: 1,
      definition: {
        name: "test-pipeline",
        version: 1,
        steps: [
          {
            id: "step_1",
            name: "S1",
            type: "llm",
            model: "gpt-4o-mini",
            prompt: "Summarize the input",
          },
        ],
      },
    };
    const versions: Array<{
      pipelineId: string;
      version: number;
      definition: Record<string, unknown>;
    }> = [];
    const definition = {
      name: "test-pipeline",
      version: 1,
      steps: [
        {
          id: "step_1",
          name: "S1",
          type: "llm",
          model: "gpt-4o-mini",
          prompt: "Summarize the input",
        },
      ],
      output: {
        from: "step_1",
        deliver: [
          {
            type: "webhook",
            url: "https://hooks.example.com/api/webhooks/outbound",
            method: "POST",
            signing_secret_name: "WEBHOOK_SIGNING_SECRET",
          },
        ],
      },
    };

    const parsed = updatePipelineSchema.safeParse({ definition });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    try {
      const securityCheck = validatePipelineSecurity(
        definition,
        existing.userId,
        "pro",
      );
      expect(securityCheck.valid).toBe(true);
      if (!securityCheck.valid) return;

      const sanitizedDefinition = securityCheck.sanitized ?? definition;
      const updated = {
        ...existing,
        ...parsed.data,
        definition: sanitizedDefinition,
        version: existing.version + 1,
        updatedAt: new Date(),
      };
      versions.push({
        pipelineId: existing.id,
        version: updated.version,
        definition: sanitizedDefinition,
      });

      expect(updated.definition.output.deliver[0].type).toBe("webhook");
      expect(updated.definition.output.deliver[0].url).toBe(
        "https://hooks.example.com/api/webhooks/outbound",
      );
      expect(updated.definition.output.deliver[0].signing_secret_name).toBe(
        "WEBHOOK_SIGNING_SECRET",
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(2);
      expect(versions[0]?.definition.output.deliver[0].type).toBe("webhook");
    } finally {
      if (previousWebhookAllowlist === undefined) {
        process.env.WHITELISTED_WEBHOOK_DOMAINS = undefined;
      } else {
        process.env.WHITELISTED_WEBHOOK_DOMAINS = previousWebhookAllowlist;
      }
    }
  });
});
