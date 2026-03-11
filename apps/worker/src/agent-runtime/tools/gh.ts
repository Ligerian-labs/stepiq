import type { ToolHandler } from "./types.js";
import {
  extractHttpStatusFromHeaders,
  hostAllowed,
  toHeaderEntries,
  tryParseJson,
} from "./helpers.js";

function buildGhApiArgs(args: Record<string, unknown>): {
  argv: string[];
  token: string;
  method: string;
  path: string;
  timeoutMs: number;
} {
  const token = String(args.token || "").trim();
  if (!token) throw new Error("token is required");
  const path = String(args.path || "").trim();
  if (!path) throw new Error("path is required");
  const method = String(args.method || "GET").toUpperCase();
  const timeoutMs = Math.max(1_000, Math.min(60_000, Number(args.timeout_ms ?? 10_000)));
  const argv = ["api", path, "-X", method, "--include"];

  for (const header of toHeaderEntries(args.headers)) {
    argv.push("-H", `${header.key}: ${header.value}`);
  }
  if (args.body !== undefined && args.body !== null) {
    argv.push("--input", "-");
  }
  if (args.paginate) {
    argv.push("--paginate");
  }

  return { argv, token, method, path, timeoutMs };
}

export const ghTool: ToolHandler = async (args, context) => {
  if (
    !hostAllowed("api.github.com", context.allowedList) &&
    !hostAllowed("github.com", context.allowedList)
  ) {
    throw new Error("Domain api.github.com is not in allowlist");
  }

  const { argv, token, timeoutMs } = buildGhApiArgs(args);
  const stdin =
    args.body !== undefined && args.body !== null
      ? typeof args.body === "string"
        ? args.body
        : JSON.stringify(args.body)
      : undefined;

  const result = await context.runCommand("gh", argv, {
    timeoutMs,
    env: { GH_TOKEN: token },
    stdin,
  });

  const status = extractHttpStatusFromHeaders(result.stdout);
  const bodyStart = result.stdout.search(/\r?\n\r?\n/);
  const stdoutBody =
    bodyStart >= 0 ? result.stdout.slice(bodyStart).replace(/^\r?\n\r?\n/, "") : result.stdout;
  const parsedJson = tryParseJson(stdoutBody.trim());
  const ok = !result.timedOut && result.exitCode === 0;

  return {
    ok,
    status,
    stdout: stdoutBody,
    stderr: result.stderr,
    ...(parsedJson !== undefined ? { parsed_json: parsedJson } : {}),
    truncated: result.stdoutTruncated || result.stderrTruncated,
    duration_ms: result.durationMs,
    ...(ok
      ? {}
      : { error: result.timedOut ? "Command timed out" : "Command failed" }),
  };
};
