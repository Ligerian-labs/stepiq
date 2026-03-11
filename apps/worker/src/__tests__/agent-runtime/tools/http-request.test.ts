import { afterEach, describe, expect, it, mock } from "bun:test";
import { httpRequestTool } from "../../../agent-runtime/tools/http-request.js";

const baseContext = {
  tool: { type: "http_request" as const, name: "http_tool" },
  debugLabel: "test",
  allowedList: ["example.com"],
  runCommand: mock(async () => {
    throw new Error("unused");
  }),
};

afterEach(() => {
  mock.restore();
});

describe("httpRequestTool", () => {
  it("returns response payload", async () => {
    const fetchMock = mock(async () =>
      new Response("ok", {
        status: 201,
        headers: { "content-type": "text/plain" },
      }),
    );
    // @ts-expect-error test override
    globalThis.fetch = fetchMock;

    const result = await httpRequestTool(
      { url: "https://example.com/test", method: "POST", body: "raw-body" },
      baseContext,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.body).toBe("ok");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("raw-body");
  });

  it("rejects disallowed host", async () => {
    await expect(
      httpRequestTool({ url: "https://blocked.com" }, baseContext),
    ).rejects.toThrow("allowlist");
  });

  it("rejects localhost even without an explicit allowlist", async () => {
    await expect(
      httpRequestTool(
        { url: "http://127.0.0.1:3000/health" },
        { ...baseContext, allowedList: [] },
      ),
    ).rejects.toThrow("not allowed");
  });
});
