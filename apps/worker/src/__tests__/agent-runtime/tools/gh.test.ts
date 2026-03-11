import { describe, expect, it, mock } from "bun:test";
import { ghTool } from "../../../agent-runtime/tools/gh.js";

describe("ghTool", () => {
  it("parses status and body from gh api output", async () => {
    const runCommand = mock(async () => ({
      exitCode: 0,
      stdout: 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"name":"repo"}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 20,
    }));

    const result = await ghTool(
      { token: "abc", path: "/user/repos", method: "GET" },
      {
        tool: { type: "gh", name: "gh_api" },
        debugLabel: "test",
        allowedList: ["api.github.com"],
        runCommand,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.parsed_json).toEqual({ name: "repo" });
  });
});
