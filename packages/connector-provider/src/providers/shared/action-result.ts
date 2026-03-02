import { randomUUID } from "node:crypto";
import type { ConnectorProvider } from "@stepiq/core";
import type { ProviderActionResult } from "../../contracts.js";

export function makeActionResult(
  provider: ConnectorProvider,
  action: string,
  details: Record<string, unknown>,
): ProviderActionResult {
  return {
    ok: true,
    provider,
    action,
    external_id: randomUUID(),
    executed_at: new Date().toISOString(),
    details,
  };
}
