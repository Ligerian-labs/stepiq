import { randomUUID } from "node:crypto";
import type { ConnectorActionRequest } from "@stepiq/core";

export interface ConnectorActionResult {
  ok: boolean;
  provider: ConnectorActionRequest["provider"];
  action: string;
  external_id: string;
  executed_at: string;
  details: Record<string, unknown>;
}

export async function executeProviderAction(
  req: ConnectorActionRequest,
): Promise<ConnectorActionResult> {
  const base = {
    ok: true,
    provider: req.provider,
    action: req.action,
    external_id: randomUUID(),
    executed_at: new Date().toISOString(),
  };

  if (["slack", "discord", "telegram"].includes(req.provider)) {
    return {
      ...base,
      details: {
        target: req.target,
        text: typeof req.payload.text === "string" ? req.payload.text : null,
      },
    };
  }

  if (["linear", "jira", "monday"].includes(req.provider)) {
    return {
      ...base,
      details: {
        target: req.target,
        title: typeof req.payload.title === "string" ? req.payload.title : null,
        status:
          typeof req.payload.status === "string" ? req.payload.status : null,
      },
    };
  }

  if (req.provider === "s3") {
    return {
      ...base,
      details: {
        bucket:
          typeof req.payload.bucket === "string" ? req.payload.bucket : null,
        key: typeof req.payload.key === "string" ? req.payload.key : null,
      },
    };
  }

  if (req.provider === "github") {
    return {
      ...base,
      details: {
        repo:
          typeof req.payload.repo === "string"
            ? req.payload.repo
            : typeof req.target === "string"
              ? req.target
              : null,
        issue_number:
          typeof req.payload.issue_number === "number"
            ? req.payload.issue_number
            : null,
        title: typeof req.payload.title === "string" ? req.payload.title : null,
      },
    };
  }

  throw new Error(`Unsupported provider: ${req.provider}`);
}
