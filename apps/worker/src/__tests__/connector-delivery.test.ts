import { describe, expect, it, mock } from "bun:test";
import {
  deliverConnectorActionWithRetry,
  deliverConnectorFetchWithRetry,
} from "../connector-delivery.js";

describe("deliverConnectorActionWithRetry", () => {
  it("retries on 5xx and succeeds", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("fail", { status: 502 });
      }
      return new Response("ok", { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    // @ts-expect-error test override
    globalThis.fetch = fetchMock;

    try {
      const attempts = await deliverConnectorActionWithRetry({
        gatewayUrl: "http://localhost:3002",
        gatewayApiKey: "gateway-key",
        providerToken: "provider-token",
        request: {
          provider: "slack",
          action: "post_message",
          target: "C123",
          payload: { text: "hello" },
          idempotency_key: "run_1:slack:post_message",
          privacy_mode: "strict",
        },
      });

      expect(attempts.length).toBe(2);
      expect(attempts[0]?.ok).toBe(false);
      expect(attempts[1]?.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends idempotency and auth headers", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-StepIQ-Idempotency-Key")).toBe(
        "run_2:discord:post_message",
      );
      expect(headers.get("X-Connectors-Api-Key")).toBe("gateway");
      expect(headers.get("X-Connector-Provider-Token")).toBe("provider");
      return new Response("ok", { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    // @ts-expect-error test override
    globalThis.fetch = fetchMock;

    try {
      const attempts = await deliverConnectorActionWithRetry({
        gatewayUrl: "http://localhost:3002",
        gatewayApiKey: "gateway",
        providerToken: "provider",
        request: {
          provider: "discord",
          action: "post_message",
          target: "123",
          payload: { text: "hello" },
          idempotency_key: "run_2:discord:post_message",
          privacy_mode: "strict",
        },
      });
      expect(attempts.length).toBe(1);
      expect(attempts[0]?.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetches connector data with retries", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("temporary", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          provider: "gmail",
          mode: "fetch",
          items: [],
        }),
        { status: 200 },
      );
    });
    const originalFetch = globalThis.fetch;
    // @ts-expect-error test override
    globalThis.fetch = fetchMock;

    try {
      const result = await deliverConnectorFetchWithRetry({
        gatewayUrl: "http://localhost:3002",
        gatewayApiKey: "gateway",
        request: {
          provider: "gmail",
          query: { since: "2026-02-28T00:00:00Z" },
          auth: { access_token: "token" },
        },
      });
      expect(result.attempts.length).toBe(2);
      expect(result.attempts[0]?.ok).toBe(false);
      expect(result.attempts[1]?.ok).toBe(true);
      expect(result.responseBody).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
