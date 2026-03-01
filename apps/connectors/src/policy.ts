import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { ConnectorProvider, SanitizedToolEvent } from "@stepiq/core";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN =
  /\b(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g;
const SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g;

function redactText(input: string): string {
  return input
    .replace(EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
    .replace(SECRET_PATTERN, "[REDACTED_SECRET]");
}

function truncate(input: string, max = 10_000): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}...[TRUNCATED]`;
}

function hashValue(input: string | undefined): string | undefined {
  if (!input) return undefined;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function pickText(payload: Record<string, unknown>): string | undefined {
  const candidates = [
    payload.text,
    payload.message,
    payload.content,
    payload.body,
    payload.description,
    (payload.data as Record<string, unknown> | undefined)?.text,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function deriveEventType(payload: Record<string, unknown>): string {
  const candidates = [payload.type, payload.event_type, payload.event];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "event.received";
}

function deriveRiskFlags(rawText: string | undefined) {
  if (!rawText) {
    return {
      contains_pii: false,
      contains_secret: false,
      has_url: false,
      possible_prompt_injection: false,
    };
  }
  const lower = rawText.toLowerCase();
  return {
    contains_pii: EMAIL_PATTERN.test(rawText) || PHONE_PATTERN.test(rawText),
    contains_secret: SECRET_PATTERN.test(rawText),
    has_url: lower.includes("http://") || lower.includes("https://"),
    possible_prompt_injection:
      lower.includes("ignore previous") || lower.includes("system prompt"),
  };
}

export function sanitizeInboundEvent(input: {
  provider: ConnectorProvider;
  payload: Record<string, unknown>;
  traceId: string;
  rawRef?: string;
}): SanitizedToolEvent {
  const rawText = pickText(input.payload);
  const cleanedText = rawText ? truncate(redactText(rawText)) : undefined;
  const actorRaw =
    typeof input.payload.user_id === "string"
      ? input.payload.user_id
      : typeof input.payload.actor_id === "string"
        ? input.payload.actor_id
        : undefined;

  const eventId =
    typeof input.payload.event_id === "string" &&
    input.payload.event_id.length > 0
      ? input.payload.event_id
      : randomBytes(10).toString("hex");
  const dedupeKey = `${input.provider}:${eventId}`;

  return {
    event_id: eventId,
    occurred_at: new Date().toISOString(),
    source: input.provider,
    workspace_id:
      typeof input.payload.workspace_id === "string"
        ? input.payload.workspace_id
        : undefined,
    actor_id_hash: hashValue(actorRaw),
    channel_or_project_ref:
      typeof input.payload.channel_id === "string"
        ? input.payload.channel_id
        : typeof input.payload.project_id === "string"
          ? input.payload.project_id
          : undefined,
    event_type: deriveEventType(input.payload),
    text_clean: cleanedText,
    entities:
      typeof input.payload.entities === "object" && input.payload.entities
        ? (input.payload.entities as Record<string, unknown>)
        : {},
    risk_flags: deriveRiskFlags(rawText),
    raw_ref: input.rawRef,
    dedupe_key: dedupeKey,
    trace_id: input.traceId,
    metadata: {
      provider_message_id:
        typeof input.payload.message_id === "string"
          ? input.payload.message_id
          : undefined,
    },
  };
}

export async function persistRawPayload(params: {
  payload: Record<string, unknown>;
  traceId: string;
}): Promise<string | undefined> {
  const encryptionKeyHex = process.env.CONNECTORS_RAW_ENCRYPTION_KEY || "";
  if (!encryptionKeyHex) return undefined;

  const key = Buffer.from(encryptionKeyHex, "hex");
  if (key.length !== 32) return undefined;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(params.payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([iv, tag, encrypted]).toString("base64");
  const ttlDays = Number(process.env.CONNECTORS_RAW_RETENTION_DAYS || 7);
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 86400000);

  return JSON.stringify({
    trace_id: params.traceId,
    cipher: "aes-256-gcm",
    data: blob,
    expires_at: expiresAt.toISOString(),
  });
}

export function sanitizeActionPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      out[key] = truncate(redactText(value));
      continue;
    }
    out[key] = value;
  }
  return out;
}
