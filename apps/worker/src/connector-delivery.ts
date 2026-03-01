import type { ConnectorActionRequest } from "@stepiq/core";

export interface ConnectorDeliveryAttemptResult {
  ok: boolean;
  attempt: number;
  statusCode?: number;
  error?: string;
}

export interface ConnectorFetchRequest {
  provider: ConnectorActionRequest["provider"];
  query?: Record<string, unknown>;
  auth: {
    access_token?: string;
    bot_token?: string;
  };
  dry_run?: boolean;
}

export interface ConnectorFetchResult {
  attempts: ConnectorDeliveryAttemptResult[];
  responseBody?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverConnectorActionWithRetry(params: {
  gatewayUrl: string;
  gatewayApiKey?: string;
  providerToken?: string;
  request: ConnectorActionRequest;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<ConnectorDeliveryAttemptResult[]> {
  const maxAttempts = params.maxAttempts ?? 4;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const results: ConnectorDeliveryAttemptResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-StepIQ-Idempotency-Key": params.request.idempotency_key,
      };
      if (params.gatewayApiKey) {
        headers["X-Connectors-Api-Key"] = params.gatewayApiKey;
      }
      if (params.providerToken) {
        headers["X-Connector-Provider-Token"] = params.providerToken;
      }

      const response = await fetch(
        `${params.gatewayUrl.replace(/\/$/, "")}/actions/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(params.request),
          signal: controller.signal,
        },
      );

      const result: ConnectorDeliveryAttemptResult = {
        ok: response.ok,
        attempt,
        statusCode: response.status,
      };
      results.push(result);

      if (response.ok) return results;
      if (response.status >= 400 && response.status < 500) return results;
    } catch (error) {
      results.push({
        ok: false,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxAttempts) {
      const backoff = 1000 * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }

  return results;
}

export async function deliverConnectorFetchWithRetry(params: {
  gatewayUrl: string;
  gatewayApiKey?: string;
  request: ConnectorFetchRequest;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<ConnectorFetchResult> {
  const maxAttempts = params.maxAttempts ?? 4;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const attempts: ConnectorDeliveryAttemptResult[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (params.gatewayApiKey) {
        headers["X-Connectors-Api-Key"] = params.gatewayApiKey;
      }

      const response = await fetch(
        `${params.gatewayUrl.replace(/\/$/, "")}/steps/fetch`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(params.request),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      let parsedBody: unknown = text;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // keep raw text
      }

      attempts.push({
        ok: response.ok,
        attempt,
        statusCode: response.status,
      });
      if (response.ok) {
        return { attempts, responseBody: parsedBody };
      }
      if (response.status >= 400 && response.status < 500) {
        return { attempts, responseBody: parsedBody };
      }
    } catch (error) {
      attempts.push({
        ok: false,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxAttempts) {
      const backoff = 1000 * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }

  return { attempts };
}
