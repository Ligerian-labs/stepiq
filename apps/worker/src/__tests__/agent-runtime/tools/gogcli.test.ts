import { describe, expect, it, mock } from "bun:test";
import { gogcliTool } from "../../../agent-runtime/tools/gogcli.js";

describe("gogcliTool", () => {
  it("executes gog and parses json stdout", async () => {
    const runCommand = mock(async () => ({
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 18,
    }));

    const result = await gogcliTool(
      {
        args: ["repo", "view", "steipete/gogcli", "--json", "name"],
        token: "ghp_test",
      },
      {
        tool: { type: "gogcli", name: "gog" },
        debugLabel: "test",
        allowedList: ["github.com"],
        runCommand,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.parsed_json).toEqual({ ok: true });
  });

  it("fails when github is not allowlisted", async () => {
    await expect(
      gogcliTool(
        { args: ["repo", "list"] },
        {
          tool: { type: "gogcli", name: "gog" },
          debugLabel: "test",
          allowedList: ["example.com"],
          runCommand: async () => {
            throw new Error("unused");
          },
        },
      ),
    ).rejects.toThrow("allowlist");
  });
});
