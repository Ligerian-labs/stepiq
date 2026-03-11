import { describe, expect, it, mock } from "bun:test";
import { curlTool } from "../../../agent-runtime/tools/curl.js";

describe("curlTool", () => {
  it("returns parsed json and status", async () => {
    const runCommand = mock(async () => ({
      exitCode: 0,
      stdout: '{"ok":true}\n__STEPIQ_STATUS__:200',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 12,
    }));

    const result = await curlTool(
      { url: "https://example.com", method: "GET" },
      {
        tool: { type: "curl", name: "curl_api" },
        debugLabel: "test",
        allowedList: ["example.com"],
        runCommand,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.parsed_json).toEqual({ ok: true });
  });

  it("rejects localhost targets", async () => {
    await expect(
      curlTool(
        { url: "http://localhost:3000" },
        {
          tool: { type: "curl", name: "curl_api" },
          debugLabel: "test",
          allowedList: [],
          runCommand: mock(async () => {
            throw new Error("unused");
          }),
        },
      ),
    ).rejects.toThrow("not allowed");
  });
});
