import type { ToolHandler } from "./types.js";
import { assertSafeHttpUrl, toHeaderEntries, tryParseJson } from "./helpers.js";

function buildCurlArgs(args: Record<string, unknown>): {
  argv: string[];
  url: URL;
  method: string;
  timeoutSeconds: number;
} {
  const urlRaw = String(args.url || "");
  if (!urlRaw) throw new Error("url is required");
  const url = new URL(urlRaw);
  const method = String(args.method || "GET").toUpperCase();
  const timeoutMs = Number(args.timeout_ms ?? 10_000);
  const timeoutSeconds = Math.max(1, Math.min(60, Math.ceil(timeoutMs / 1000)));
  const argv = ["-sS", "-X", method, url.toString(), "--max-time", String(timeoutSeconds)];

  for (const header of toHeaderEntries(args.headers)) {
    argv.push("-H", `${header.key}: ${header.value}`);
  }
  if (args.body !== undefined && args.body !== null) {
    argv.push("--data", typeof args.body === "string" ? args.body : JSON.stringify(args.body));
  }

  argv.push("-w", "\\n__STEPIQ_STATUS__:%{http_code}");
  return { argv, url, method, timeoutSeconds };
}

export const curlTool: ToolHandler = async (args, context) => {
  const { argv, url, timeoutSeconds } = buildCurlArgs(args);
  assertSafeHttpUrl(url.toString(), context.allowedList);

  const result = await context.runCommand("curl", argv, {
    timeoutMs: timeoutSeconds * 1000 + 1000,
  });
  const statusMatch = result.stdout.match(/\n__STEPIQ_STATUS__:(\d{3})\s*$/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const stdout = statusMatch
    ? result.stdout.replace(/\n__STEPIQ_STATUS__:\d{3}\s*$/, "")
    : result.stdout;
  const parsedJson = tryParseJson(stdout.trim());
  const ok = !result.timedOut && result.exitCode === 0;

  return {
    ok,
    status,
    stdout,
    stderr: result.stderr,
    ...(parsedJson !== undefined ? { parsed_json: parsedJson } : {}),
    truncated: result.stdoutTruncated || result.stderrTruncated,
    duration_ms: result.durationMs,
    ...(ok
      ? {}
      : { error: result.timedOut ? "Command timed out" : "Command failed" }),
  };
};
