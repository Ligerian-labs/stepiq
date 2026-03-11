import { describe, expect, it, mock } from "bun:test";
import {
  compactToolResultForModel,
  executeToolCall,
} from "../../../agent-runtime/tools/dispatcher.js";

describe("executeToolCall", () => {
  it("routes tool call to matching handler", async () => {
    const payload = JSON.stringify({
      name: "extractor",
      arguments: JSON.stringify({ text: '{"a":{"b":1}}', path: "a.b" }),
      network_allowlist: [],
    });

    const raw = await executeToolCall(payload, {
      tools: [{ type: "extract_json", name: "extractor" }],
      debugLabel: "test",
      onLog: mock(() => {}),
    });

    expect(JSON.parse(raw)).toEqual({ ok: true, value: 1 });
  });

  it("returns error for unknown tool", async () => {
    const payload = JSON.stringify({
      name: "missing",
      arguments: "{}",
    });

    const raw = await executeToolCall(payload, {
      tools: [{ type: "extract_json", name: "extractor" }],
      debugLabel: "test",
    });

    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Unknown tool");
  });

  it("compacts oversized tool results before returning them to the model", async () => {
    const largeBody = "x".repeat(20_000);

    const compacted = compactToolResultForModel({
      ok: true,
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-security-policy": "y".repeat(10_000),
      },
      body: largeBody,
    });

    expect(compacted.ok).toBe(true);
    expect(compacted.model_context_truncated).toBe(true);
    expect(String(compacted.body).length).toBeLessThan(8_200);
    expect(compacted.headers).toEqual({
      "content-type": "text/html",
      "content-security-policy":
        expect.stringContaining("[truncated"),
    });
  });

  it("returns compacted payloads from tool execution", async () => {
    const payload = JSON.stringify({
      name: "scripted",
      arguments: JSON.stringify({}),
      network_allowlist: [],
    });

    const raw = await executeToolCall(payload, {
      tools: [
        {
          type: "js",
          name: "scripted",
          js_source: `() => ({ body: "x".repeat(20000), nested: { stdout: "y".repeat(12000) } })`,
        },
      ],
      debugLabel: "test",
      onLog: mock(() => {}),
    });

    const result = JSON.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.model_context_truncated).toBe(true);
    expect(String(result.output.body).length).toBeLessThan(8_200);
    expect(String(result.output.nested.stdout)).toContain("[truncated");
  });
});
