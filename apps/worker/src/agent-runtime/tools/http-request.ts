import type { ToolHandler } from "./types.js";
import { assertSafeHttpUrl } from "./helpers.js";

const RESPONSE_MAX_BYTES = 64_000;

export const httpRequestTool: ToolHandler = async (args, context) => {
  const url = String(args.url || "");
  if (!url) throw new Error("url is required");
  const parsed = assertSafeHttpUrl(url, context.allowedList);

  const method = String(args.method || "GET").toUpperCase();
  const headers = ((args.headers || {}) as Record<string, string>) || {};
  const body = args.body;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(parsed.toString(), {
      method,
      headers,
      body:
        body == null
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const clipped = text.slice(0, RESPONSE_MAX_BYTES);
    return {
      ok: true,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: clipped,
      truncated: text.length > clipped.length,
    };
  } finally {
    clearTimeout(timeout);
  }
};
