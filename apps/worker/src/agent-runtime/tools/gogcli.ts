import type { ToolHandler } from "./types.js";
import { hostAllowed, tryParseJson } from "./helpers.js";

const MAX_ARGS = 100;

function toArgv(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, MAX_ARGS);
}

export const gogcliTool: ToolHandler = async (args, context) => {
  if (
    context.allowedList.length > 0 &&
    !hostAllowed("github.com", context.allowedList) &&
    !hostAllowed("api.github.com", context.allowedList)
  ) {
    throw new Error("Domain github.com is not in allowlist");
  }

  const argv = toArgv(args.args ?? args.argv);
  const timeoutMs = Math.max(
    1_000,
    Math.min(60_000, Number(args.timeout_ms ?? 10_000)),
  );
  const token = typeof args.token === "string" ? args.token.trim() : "";
  const env = {
    ...(args.env && typeof args.env === "object"
      ? (Object.fromEntries(
          Object.entries(args.env as Record<string, unknown>).map(
            ([k, v]) => [String(k), String(v)],
          ),
        ) as Record<string, string>)
      : {}),
    ...(token ? { GITHUB_TOKEN: token, GH_TOKEN: token } : {}),
  };
  const stdin =
    args.stdin == null
      ? undefined
      : typeof args.stdin === "string"
        ? args.stdin
        : JSON.stringify(args.stdin);

  const result = await context.runCommand("gog", argv, {
    timeoutMs,
    env,
    stdin,
  });

  const parsedJson = tryParseJson(result.stdout.trim());
  const ok = !result.timedOut && result.exitCode === 0;
  return {
    ok,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(parsedJson !== undefined ? { parsed_json: parsedJson } : {}),
    truncated: result.stdoutTruncated || result.stderrTruncated,
    duration_ms: result.durationMs,
    ...(ok
      ? {}
      : { error: result.timedOut ? "Command timed out" : "Command failed" }),
  };
};
