import {
  PLAN_LIMITS,
  SAFE_AGENT_TOOL_TYPES,
  type PipelineDefinition,
} from "@stepiq/core";
import { ALLOWED_STEP_TYPES } from "./chat-security.js";
const EXECUTABLE_STEP_TYPES = ["llm", "transform"] as const;

interface PipelineValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: PipelineDefinition;
}

export function validatePipelineSecurity(
  pipeline: PipelineDefinition,
  userId: string,
  userPlan: string,
): PipelineValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!pipeline.steps || !Array.isArray(pipeline.steps)) {
    errors.push("Pipeline must have a valid steps array");
    return { valid: false, errors, warnings };
  }

  for (const step of pipeline.steps) {
    if (!step.type) {
      errors.push("Step missing required 'type' field");
      continue;
    }

    if (!ALLOWED_STEP_TYPES.includes(step.type)) {
      errors.push(
        `Step type "${step.type}" is not allowed. Allowed types: ${ALLOWED_STEP_TYPES.join(", ")}`,
      );
    }

    if (!EXECUTABLE_STEP_TYPES.includes(step.type as (typeof EXECUTABLE_STEP_TYPES)[number])) {
      errors.push(
        `Step type "${step.type}" is not executable in the current runtime. Use: ${EXECUTABLE_STEP_TYPES.join(", ")}`,
      );
    }

    if ((step.type === "llm" || step.type === "transform") && !step.prompt) {
      errors.push(`Step "${step.name}" is missing required "prompt"`);
    }

    if (step.system_prompt && containsUnauthorizedUrls(step.system_prompt)) {
      errors.push(`Step "${step.name}" system prompt contains unauthorized external URLs`);
    }

    if ("code" in step || step.type === "code") {
      errors.push("Code execution steps are not allowed for security reasons");
    }

    if (step.prompt && containsUnauthorizedUrls(step.prompt)) {
      errors.push("Step contains unauthorized external URLs");
    }

    if (step.prompt && containsSensitivePatterns(step.prompt)) {
      warnings.push("Step prompt may contain sensitive data");
    }

    if (step.type === "llm" && step.agent) {
      if (step.agent.allow_parallel_tools) {
        errors.push("Parallel agent tools are not supported in this runtime");
      }

      const tools = step.agent.tools || [];
      for (const tool of tools) {
        if (
          !SAFE_AGENT_TOOL_TYPES.includes(
            tool.type as (typeof SAFE_AGENT_TOOL_TYPES)[number],
          )
        ) {
          errors.push(`Agent tool type "${tool.type}" is not allowed`);
        }
        if ("js_source" in tool) {
          errors.push(`Agent tool "${tool.name}" cannot include inline JavaScript`);
        }
      }
    }
  }

  const planLimits =
    PLAN_LIMITS[userPlan as keyof typeof PLAN_LIMITS] || PLAN_LIMITS.free;
  if (pipeline.steps.length > planLimits.max_steps_per_pipeline) {
    errors.push(
      `Pipeline exceeds maximum steps (${planLimits.max_steps_per_pipeline}) for your plan`,
    );
  }

  const pipelineString = JSON.stringify(pipeline);
  if (containsSensitivePatterns(pipelineString)) {
    warnings.push("Pipeline definition may expose sensitive data");
  }

  if (pipeline.output?.deliver) {
    for (const target of pipeline.output.deliver) {
      if (target.type === "webhook" && target.url) {
        if (!isWhitelistedUrl(target.url)) {
          errors.push(`Webhook URL "${target.url}" is not whitelisted`);
        }
      }
    }
  }

  if ("isPublic" in pipeline || "public" in pipeline) {
    errors.push("Public pipelines are not allowed in Builder");
  }

  const sanitized = sanitizePipeline(pipeline);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sanitized: errors.length === 0 ? sanitized : undefined,
  };
}

function containsUnauthorizedUrls(text: string): boolean {
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const urls = text.match(urlPattern) || [];

  for (const url of urls) {
    try {
      if (!isPublicUrl(url)) return true;
    } catch {
      // Invalid URL, skip
    }
  }

  return false;
}

function isPrivateIpV4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isPublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return false;
    }

    if (hostname.includes(":")) return false; // block raw ipv6 targets
    if (isPrivateIpV4(hostname)) return false;
    if (hostname === "169.254.169.254") return false;
    return true;
  } catch {
    return false;
  }
}

function containsSensitivePatterns(text: string): boolean {
  const sensitivePatterns = [
    /api[_-]?key/i,
    /secret/i,
    /password/i,
    /token/i,
    /credential/i,
    /private[_-]?key/i,
  ];

  return sensitivePatterns.some((pattern) => pattern.test(text));
}

function isWhitelistedUrl(url: string): boolean {
  const allowedDomains =
    process.env.WHITELISTED_WEBHOOK_DOMAINS?.split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean) || [];
  if (allowedDomains.length === 0) {
    return true;
  }

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function sanitizePipeline(pipeline: PipelineDefinition): PipelineDefinition {
  const { ...rest } = pipeline;
  const sanitized: PipelineDefinition = rest;

  sanitized.steps = sanitized.steps.map((step) => {
    const { ...stepRest } = step;
    return stepRest;
  });

  return sanitized;
}
