import { isIP } from "node:net";
import { spawn } from "node:child_process";
import type { CommandResult, RunCommandFn } from "./types.js";

export function parseGlobalAllowlist(): string[] {
  const raw = process.env.AGENT_HTTP_ALLOWLIST || "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function hostAllowed(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((item) => {
    if (item.startsWith("*.")) {
      const suffix = item.slice(1).toLowerCase();
      return host.endsWith(suffix);
    }
    return host === item;
  });
}

export function effectiveAllowlist(
  globalList: string[],
  localList: string[],
): string[] {
  if (globalList.length === 0) return localList;
  if (localList.length === 0) return globalList;
  return localList.filter((entry) =>
    hostAllowed(entry.replace(/^\*\./, "x."), globalList),
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    if (normalized === "169.254.169.254") return true;
    return isPrivateIpv4(normalized);
  }

  if (ipVersion === 6) {
    return true;
  }

  return false;
}

export function assertSafeHttpUrl(rawUrl: string, allowlist: string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error(`Domain ${url.hostname} is not allowed`);
  }
  if (!hostAllowed(url.hostname, allowlist)) {
    throw new Error(`Domain ${url.hostname} is not in allowlist`);
  }
  return url;
}

export function jsonPathLookup(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== "object") return undefined;
      return (acc as Record<string, unknown>)[key];
    }, value);
}

export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function toHeaderEntries(
  headers: unknown,
): Array<{ key: string; value: string }> {
  if (!headers || typeof headers !== "object") return [];
  return Object.entries(headers as Record<string, unknown>)
    .filter(([k, v]) => typeof k === "string" && v != null)
    .map(([k, v]) => ({ key: String(k), value: String(v) }));
}

export function extractHttpStatusFromHeaders(stdout: string): number | undefined {
  const lines = stdout.split(/\r?\n/);
  let lastStatus: number | undefined;
  for (const line of lines) {
    const match = line.match(/^HTTP\/[0-9.]+\s+(\d{3})\b/);
    if (match) lastStatus = Number(match[1]);
  }
  return lastStatus;
}

export const runCommand: RunCommandFn = async (
  command,
  argv,
  options,
): Promise<CommandResult> => {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const maxOutputBytes = options?.maxOutputBytes ?? 64_000;
  const child = spawn(command, argv, {
    env: { ...process.env, ...(options?.env || {}) },
    stdio: "pipe",
    shell: false,
  });

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let settled = false;

  const append = (target: "stdout" | "stderr", chunk: string) => {
    if (target === "stdout") {
      if (stdout.length >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdout.length;
      stdout += chunk.slice(0, remaining);
      if (chunk.length > remaining) stdoutTruncated = true;
      return;
    }

    if (stderr.length >= maxOutputBytes) {
      stderrTruncated = true;
      return;
    }
    const remaining = maxOutputBytes - stderr.length;
    stderr += chunk.slice(0, remaining);
    if (chunk.length > remaining) stderrTruncated = true;
  };

  child.stdout?.on("data", (buf: Buffer | string) => append("stdout", String(buf)));
  child.stderr?.on("data", (buf: Buffer | string) => append("stderr", String(buf)));

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, timeoutMs);

  if (options?.stdin != null && child.stdin) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }

  return await new Promise((resolveCommand, rejectCommand) => {
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
};
