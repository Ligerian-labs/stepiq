import { describe, expect, it } from "bun:test";
import { CONNECTOR_PROVIDERS, type ConnectorProvider } from "@stepiq/core";
import { getProviderAdapter } from "../index.js";

describe("connector provider registry", () => {
  it("returns an adapter for every configured provider", () => {
    for (const provider of CONNECTOR_PROVIDERS) {
      const adapter = getProviderAdapter(provider as ConnectorProvider);
      expect(adapter.provider).toBe(provider);
      const capabilities = adapter.getCapabilities();
      expect(capabilities.length).toBeGreaterThan(0);
      expect(new Set(capabilities.map((c) => c.id)).size).toBe(
        capabilities.length,
      );
    }
  });
});
