# Connectors Gateway

Privacy-first bidirectional connector service for Stepiq.

This service handles:
- inbound events from external tools (push input to pipelines)
- inbound data pulls from external tools (pull input to pipelines)
- outbound action execution requests from pipelines (output from pipelines)

It enforces a sanitization boundary so LLM-facing pipeline context receives only normalized and redacted data.

## Status

Current implementation includes:
- HTTP API for inbound and outbound connector flows
- schema validation against shared `@stepiq/core` schemas
- deterministic text redaction and payload sanitization
- optional encrypted short-retention raw payload references
- retry-capable worker client integration on outbound path
- in-memory idempotency cache for outbound actions
- source-side pull fetch for Gmail, Discord, and GitHub

Provider execution in `src/providers.ts` is currently a structured stub layer. It returns normalized success payloads and is designed to be replaced with real provider SDK/API calls.

## Directory Overview

- `src/index.ts`: process entrypoint and HTTP server bootstrap
- `src/app.ts`: route handlers and auth checks
- `src/policy.ts`: privacy controls (redaction, risk flags, raw payload encryption helper)
- `src/fetchers.ts`: provider pull-based inbound fetch implementations
- `src/providers.ts`: outbound provider action execution abstraction

## Architecture

### Inbound flow (push: tool webhook -> connectors -> Stepiq webhook)

1. Receive event at `POST /inbound/:provider/:pipelineId`.
2. Validate provider against supported connector list.
3. Optionally enforce `X-Connector-Ingest-Token`.
4. Build `trace_id`.
5. Optionally produce encrypted raw payload reference (`raw_ref`) when encryption key is configured.
6. Convert payload to `SanitizedToolEvent` (redacted text, hashed actor ID, risk flags, normalized fields).
7. Validate event schema.
8. Forward to Stepiq API webhook:
   - `POST {CONNECTORS_STEPIQ_URL}/api/webhooks/:pipelineId`
   - header `X-API-Key`
   - body `{ "input_data": <SanitizedToolEvent> }`

### Inbound flow (pull: connectors fetch -> Stepiq webhook)

1. Caller requests source fetch at `POST /inbound/fetch`.
2. Connectors validates provider + fetch query.
3. Connectors calls provider APIs directly (current implementations: Gmail, Discord).
   The service paginates provider APIs until `max_items` is reached (bounded).
4. Each fetched item is normalized and sanitized.
5. Each sanitized item is forwarded to Stepiq webhook as `input_data`.
6. Response contains per-item success/failure status.

### Outbound flow (worker -> connectors -> provider)

1. Worker detects `output.deliver[]` with `type: "connector"`.
2. Worker sends `ConnectorActionRequest` to `POST /actions/execute`.
3. Connectors validates auth (`X-Connectors-Api-Key`, optional).
4. Connectors validates request schema and sanitizes string payload fields.
5. Idempotency check:
   - key: `idempotency_key`
   - cache: in-memory map
   - TTL: 10 minutes
6. Execute provider action through `executeProviderAction`.
7. Return normalized response payload.

## Supported Providers

Provider enum (shared contract):
- `gmail`
- `github`
- `slack`
- `discord`
- `telegram`
- `linear`
- `jira`
- `monday`
- `s3`

Implemented pull-based source fetch:
- `gmail`
- `discord`
- `github`

## API Reference

### `GET /health`

Health probe.

Response:
```json
{ "status": "ok", "service": "connectors" }
```

### `POST /inbound/:provider/:pipelineId`

Ingests external provider payloads, sanitizes them, and triggers a Stepiq pipeline webhook.

Path params:
- `provider`: one of supported providers
- `pipelineId`: Stepiq pipeline ID to trigger

Headers:
- `Content-Type: application/json`
- `X-Connector-Ingest-Token: <token>` (required only if `CONNECTORS_INGEST_TOKEN` is set)

Body:
- arbitrary provider payload JSON object
- optional `pipeline_api_key` field can override default webhook API key for this request

Response codes:
- `202`: event accepted and forwarded to Stepiq
- `400`: invalid provider or invalid JSON object
- `401`: missing/invalid ingest token (when configured)
- `422`: sanitized event did not pass schema validation
- `500`: missing Stepiq API key configuration
- `502`: Stepiq webhook call failed

Success response shape:
```json
{
  "accepted": true,
  "provider": "gmail",
  "trace_id": "uuid",
  "pipeline_id": "pipeline-uuid",
  "webhook_response": {
    "accepted": true,
    "run_id": "..."
  }
}
```

### `POST /inbound/fetch`

Actively fetches records from a provider and emits sanitized events to a pipeline.

Headers:
- `Content-Type: application/json`
- `X-Connector-Ingest-Token: <token>` (required only if `CONNECTORS_INGEST_TOKEN` is set)

Body:
- `provider`: connector provider
- `pipeline_id`: target Stepiq pipeline ID
- `query`: provider-specific fetch config
- `auth`: provider auth credentials for the fetch operation
- `dry_run` (optional): if true, fetch and normalize without forwarding to Stepiq

Current provider-specific pull support:
- Gmail
  - `auth.access_token` required
  - `query.since` optional ISO datetime
  - `query.until` optional ISO datetime
  - `query.max_items` optional (default 25, max 1000)
  - `query.gmail_query` optional Gmail search terms
- Discord
  - `auth.bot_token` required
  - `query.channel_id` required
  - `query.max_items` optional (default 50, max 1000)
  - `query.before` optional message cursor
- GitHub
  - `auth.access_token` required
  - `query.repo_owner` required
  - `query.repo_name` required
  - `query.type` optional: `issues | pulls` (default `issues`)
  - `query.state` optional (default `open`)
  - `query.since` optional ISO datetime
  - `query.max_items` optional (default 50, max 1000)

Response shape:
```json
{
  "provider": "gmail",
  "pipeline_id": "pipeline-uuid",
  "fetched_count": 12,
  "accepted_count": 12,
  "failed_count": 0,
  "dry_run": false,
  "results": [
    {
      "event_id": "18f6...",
      "accepted": true,
      "trace_id": "e4f4..."
    }
  ]
}
```

### `POST /actions/execute`

Executes outbound connector actions requested by worker/pipeline delivery.

Headers:
- `Content-Type: application/json`
- `X-Connectors-Api-Key: <api-key>` (required only if `CONNECTORS_GATEWAY_API_KEY` is set)

Body contract (`ConnectorActionRequest`):
- `provider`: connector provider enum
- `action`: action name (string)
- `payload`: object
- `idempotency_key`: string
- `privacy_mode`: `strict | balanced` (default `strict`)
- optional: `target`, `auth_secret_name`, `dry_run`, `trace_id`

Response codes:
- `200`: action processed (or returned from idempotency cache)
- `400`: invalid request schema
- `401`: missing/invalid gateway API key (when configured)

Response shape:
```json
{
  "ok": true,
  "request": {
    "provider": "slack",
    "action": "post_message",
    "target": "C123",
    "idempotency_key": "run:...",
    "privacy_mode": "strict"
  },
  "result": {
    "ok": true,
    "provider": "slack",
    "action": "post_message",
    "external_id": "uuid",
    "executed_at": "2026-03-01T...",
    "details": {}
  }
}
```

Cached idempotent replay adds:
```json
{ "ok": true, "cached": true, ... }
```

## Privacy Model

### Sanitization behavior

Inbound text extraction checks common fields:
- `text`, `message`, `content`, `body`, `description`, `data.text`

String redaction currently masks:
- email addresses -> `[REDACTED_EMAIL]`
- phone numbers -> `[REDACTED_PHONE]`
- common secret/token patterns -> `[REDACTED_SECRET]`

Then text is truncated to max 10k chars.

### Derived metadata

`SanitizedToolEvent` includes:
- `actor_id_hash`: SHA-256 hash of actor/user identifier
- `risk_flags`:
  - `contains_pii`
  - `contains_secret`
  - `has_url`
  - `possible_prompt_injection`

### Raw payload retention

When `CONNECTORS_RAW_ENCRYPTION_KEY` is configured (32-byte key, hex-encoded):
- raw inbound payload is encrypted with AES-256-GCM
- service returns `raw_ref` JSON blob inside event
- `expires_at` is derived from `CONNECTORS_RAW_RETENTION_DAYS`

Important:
- current implementation stores encrypted raw payload as an inline reference string, not in external object storage yet
- integrate this with S3/MinIO for production durability and lifecycle enforcement

## Configuration

Environment variables used by this service:

- `CONNECTORS_PORT`
  - default: `3002`
  - HTTP listen port

- `CONNECTORS_INGEST_TOKEN`
  - optional
  - if set, required for inbound endpoints via `X-Connector-Ingest-Token`

- `CONNECTORS_GATEWAY_API_KEY`
  - optional
  - if set, required for outbound action endpoint via `X-Connectors-Api-Key`

- `CONNECTORS_STEPIQ_URL`
  - default: `http://localhost:3001`
  - base URL of Stepiq API

- `CONNECTORS_STEPIQ_API_KEY`
  - optional globally, required in practice unless each inbound request carries `pipeline_api_key`
  - used for forwarding sanitized events to Stepiq webhook route

- `CONNECTORS_RAW_ENCRYPTION_KEY`
  - optional
  - must be 64 hex chars (32 bytes)
  - enables encrypted raw payload reference generation

- `CONNECTORS_RAW_RETENTION_DAYS`
  - default: `7`
  - used for `expires_at` in raw payload reference metadata

## Local Development

From repo root:

```bash
set -a; source .env; set +a
bun run --filter @stepiq/connectors dev
```

Health check:

```bash
curl http://localhost:3002/health
```

## Examples

### Push inbound example (Slack event -> Stepiq pipeline)

```bash
curl -X POST "http://localhost:3002/inbound/slack/<pipeline-id>" \
  -H "Content-Type: application/json" \
  -H "X-Connector-Ingest-Token: $CONNECTORS_INGEST_TOKEN" \
  -d '{
    "event_id": "evt_123",
    "workspace_id": "T1",
    "channel_id": "C1",
    "user_id": "U1",
    "type": "message.created",
    "text": "Contact me at jane@example.com, key sk-abc123abc123"
  }'
```

### Pull inbound example (Gmail: emails from yesterday -> pipeline)

```bash
SINCE=$(date -u -v-1d +"%Y-%m-%dT00:00:00Z")
UNTIL=$(date -u +"%Y-%m-%dT00:00:00Z")

curl -X POST "http://localhost:3002/inbound/fetch" \
  -H "Content-Type: application/json" \
  -H "X-Connector-Ingest-Token: $CONNECTORS_INGEST_TOKEN" \
  -d "{
    \"provider\": \"gmail\",
    \"pipeline_id\": \"<pipeline-id>\",
    \"auth\": { \"access_token\": \"$GMAIL_ACCESS_TOKEN\" },
    \"query\": {
      \"since\": \"$SINCE\",
      \"until\": \"$UNTIL\",
      \"max_items\": 50
    }
  }"
```

### Pull inbound example (Discord: channel history -> pipeline)

```bash
curl -X POST "http://localhost:3002/inbound/fetch" \
  -H "Content-Type: application/json" \
  -H "X-Connector-Ingest-Token: $CONNECTORS_INGEST_TOKEN" \
  -d '{
    "provider": "discord",
    "pipeline_id": "<pipeline-id>",
    "auth": { "bot_token": "'"$DISCORD_BOT_TOKEN"'" },
    "query": {
      "channel_id": "123456789012345678",
      "max_items": 100
    }
  }'
```

### Pull inbound example (GitHub: recent issues from a repository -> pipeline)

```bash
curl -X POST "http://localhost:3002/inbound/fetch" \
  -H "Content-Type: application/json" \
  -H "X-Connector-Ingest-Token: $CONNECTORS_INGEST_TOKEN" \
  -d '{
    "provider": "github",
    "pipeline_id": "<pipeline-id>",
    "auth": { "access_token": "'"$GITHUB_TOKEN"'" },
    "query": {
      "repo_owner": "octocat",
      "repo_name": "hello-world",
      "type": "issues",
      "state": "open",
      "max_items": 100
    }
  }'
```

### Outbound example (worker/action client call)

```bash
curl -X POST "http://localhost:3002/actions/execute" \
  -H "Content-Type: application/json" \
  -H "X-Connectors-Api-Key: $CONNECTORS_GATEWAY_API_KEY" \
  -d '{
    "provider": "slack",
    "action": "post_message",
    "target": "C123",
    "payload": { "text": "Pipeline completed for user john@example.com" },
    "idempotency_key": "run:abc:slack:post_message:1",
    "privacy_mode": "strict"
  }'
```

### Pipeline output definition example

```yaml
output:
  from: summarize
  deliver:
    - type: connector
      provider: slack
      action: post_message
      target: C123456
      payload:
        text: "Run {{steps.summarize.output}}"
      auth_secret_name: SLACK_BOT_TOKEN
      idempotency_key: "{{run.id}}:slack:post_message"
      privacy_mode: strict
```

## Reliability and Idempotency

Worker-side retries are implemented in `apps/worker/src/connector-delivery.ts`:
- exponential backoff
- retries on network errors and 5xx
- stop early on 4xx

Idempotency model:
- required `idempotency_key` in action requests
- current gateway cache is in-memory and process-local
- for multi-instance or restart-safe idempotency, migrate cache to Redis/Postgres

## Security Notes

- Do not expose endpoints publicly without network controls and auth headers enabled.
- Always set:
  - `CONNECTORS_INGEST_TOKEN`
  - `CONNECTORS_GATEWAY_API_KEY`
  - `CONNECTORS_STEPIQ_API_KEY`
- Prefer TLS termination at ingress/proxy.
- Rotate secrets and API keys regularly.
- Keep `CONNECTORS_RAW_ENCRYPTION_KEY` out of logs and commit history.

## Extending Providers (Productionizing)

To add real provider execution:

1. Keep request validation in `connectorActionRequestSchema`.
2. Add provider-specific action schema refinement if needed.
3. Replace branch in `executeProviderAction` with actual API/SDK call.
4. Map provider response to normalized `ConnectorActionResult`.
5. Add idempotency support per provider if available (headers/body fields).
6. Add adapter tests for:
   - success path
   - 4xx/5xx handling
   - retry behavior
   - duplicate replay behavior

For inbound providers:
1. Normalize payload in `sanitizeInboundEvent`.
2. Avoid adding raw fields to `SanitizedToolEvent`.
3. Add schema and sanitizer tests for new payload shapes.
4. For pull providers, add fetch logic in `src/fetchers.ts` with bounded pagination/time windows.

## Known Gaps / Next Steps

- replace in-memory idempotency cache with persistent store
- persist encrypted raw payload references in S3/MinIO instead of inline blob
- add per-provider OAuth/token lifecycle management
- add provider webhook signature verification (Slack/Discord/Jira/etc.)
- add per-provider allowlists and strict action schemas
- add integration tests for full worker -> connectors -> provider flow
