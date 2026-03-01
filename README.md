# Stepiq

**AI Pipeline Builder** - Chain models, write prompts, schedule everything.

By [Ligerian Labs](https://ligerianlabs.fr)

## Architecture

Monorepo with runtime apps and reusable packages:

| Path | Description | Tech |
|------|-------------|------|
| `apps/api` | REST API server | Hono, Drizzle, PostgreSQL |
| `apps/connectors` | Privacy gateway for bidirectional connectors | Hono |
| `apps/worker` | Pipeline executor + cron scheduler | BullMQ, Redis |
| `apps/landing` | Marketing website | Astro 5, Tailwind |
| `apps/app` | Product web app | React, Vite, TanStack Router + Query |
| `packages/core` | Shared types, schemas, constants | Zod, TypeScript |
| `packages/ui` | Shared UI/helpers for React apps | TypeScript, React |

## Quick Start (Manual Local Debug)

### 1. Create `.env`

From repo root:

```bash
cp .env.example .env
```

Then update `.env` to:

```env
DATABASE_URL=postgres://stepiq:stepiq@localhost:5433/stepiq
REDIS_URL=redis://localhost:6379
JWT_SECRET=local-dev-jwt-secret-change-me-please
API_URL=http://localhost:3001
CLERK_SECRET_KEY=
CLERK_JWKS_URL=
CLERK_API_URL=https://api.clerk.com
# 64 hex chars (32 bytes), required for user secrets encryption
STEPIQ_MASTER_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
MISTRAL_API_KEY=
RESEND_API_KEY=
EMAIL_FROM=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER_MONTHLY_EUR=
STRIPE_PRICE_STARTER_YEARLY_EUR=
STRIPE_PRICE_PRO_MONTHLY_EUR=
STRIPE_PRICE_PRO_YEARLY_EUR=
AUTHORIZED_ADMIN_EMAILS=admin@stepiq.sh,ops@stepiq.sh
APP_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
PUBLIC_API_URL=http://localhost:3001
VITE_API_URL=http://localhost:3001
VITE_CLERK_PUBLISHABLE_KEY=
CONNECTORS_PORT=3002
CONNECTORS_INGEST_TOKEN=
CONNECTORS_GATEWAY_API_KEY=
CONNECTORS_STEPIQ_URL=http://localhost:3001
CONNECTORS_STEPIQ_API_KEY=
CONNECTORS_RAW_ENCRYPTION_KEY=
CONNECTORS_RAW_RETENTION_DAYS=7
CONNECTORS_GATEWAY_URL=http://localhost:3002
```

### 2. Start local infra

```bash
docker compose -f compose.yaml up -d
```

### 3. Install dependencies and run migrations

```bash
bun install
set -a; source .env; set +a
bun run db:migrate
```

### 4. Start services (5 terminals)

Terminal A (API):

```bash
set -a; source .env; set +a
bun run --filter @stepiq/api dev
```

Terminal B (Worker):

```bash
set -a; source .env; set +a
bun run --filter @stepiq/worker dev
```

Terminal C (Connectors):

```bash
set -a; source .env; set +a
bun run --filter @stepiq/connectors dev
```

Terminal D (App):

```bash
set -a; source .env; set +a
bun run --filter @stepiq/app dev
```

Terminal E (Landing):

```bash
set -a; source .env; set +a
bun run --filter @stepiq/landing dev
```

Services:
- **Landing:** http://localhost:4321
- **App:** http://localhost:5173
- **API:** http://localhost:3001
- **Connectors:** http://localhost:3002
- **API Health:** http://localhost:3001/health

### 5. Verify

```bash
curl http://localhost:3001/health
```

Expected:

```json
{"status":"ok","version":"0.0.1"}
```

### 6. Stop infra (optional)

```bash
docker compose -f compose.yaml down
```

## Project Structure

```text
stepiq/
├── apps/
│   ├── api/          # Hono REST API
│   ├── connectors/   # Connector privacy gateway (inbound + outbound)
│   ├── worker/       # BullMQ workers + cron scheduler
│   ├── landing/      # Astro landing pages
│   └── app/          # React + Vite + TanStack product app
├── packages/
│   ├── core/         # Shared types, Zod schemas, constants
│   └── ui/           # Shared React UI utilities/components
├── compose.yaml      # Local dev infra (Postgres + Redis)
├── docker/           # Container files for other environments
└── biome.json        # Linter/formatter config
```

## API Endpoints

See [full spec](https://github.com/Ligerian-labs/brainstorm/blob/main/products/ai-pipelines/SPEC.md) for complete API documentation.

### Core routes:
- `POST /api/auth/register` - Sign up
- `POST /api/auth/register/request-code` - Send email verification code
- `POST /api/auth/login` - Sign in
- `POST /api/auth/clerk/exchange` - Exchange Clerk session token for API JWT
- `GET /api/billing/discount-codes` - List discount codes (admin-only)
- `POST /api/billing/discount-codes` - Create/update discount code (admin-only)
- `GET /api/pipelines` - List pipelines
- `POST /api/pipelines` - Create pipeline
- `POST /api/pipelines/:id/run` - Execute pipeline
- `GET /api/runs/:id` - Get run details (with step-by-step logs)
- `GET /api/runs/:id/stream` - SSE real-time updates
- `POST /api/pipelines/:id/schedules` - Create cron schedule
- `GET /api/models` - List available models + pricing
- `POST /api/webhooks/:pipelineId` - Trigger pipeline from external webhook (`X-API-Key`)
- `GET /api/user/api-keys` - List API keys
- `POST /api/user/api-keys` - Create API key
- `DELETE /api/user/api-keys/:id` - Revoke API key

### Connectors gateway endpoints

- `POST /inbound/:provider/:pipelineId` - Ingest provider event, sanitize, and trigger Stepiq webhook
- `POST /actions/execute` - Execute validated outbound connector action

### Inbound webhook trigger example

```bash
curl -X POST "http://localhost:3001/api/webhooks/<pipeline-id>" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_live_xxxxxxxx" \
  -d '{"input_data":{"topic":"AI agents","language":"en"}}'

# Alternative (for webhook providers that can't set custom headers):
curl -X POST "http://localhost:3001/api/webhooks/<pipeline-id>?api_key=sk_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"input_data":{"topic":"AI agents","language":"en"}}'
```

Response (`202`):

```json
{
  "accepted": true,
  "run_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "pending",
  "pipeline_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### Outbound webhook delivery

When a pipeline has an output delivery target of type `webhook`, the worker sends a signed JSON payload with retry (up to 4 attempts with exponential backoff).

Headers:
- `X-StepIQ-Event: pipeline.run.completed`
- `X-StepIQ-Timestamp: <unix-seconds>`
- `X-StepIQ-Signature: v1=<hex-hmac-sha256>`

Signature payload format:
- `HMAC_SHA256(signing_secret, "<timestamp>.<raw_json_body>")`

### Local debug sink for outbound webhooks

Use these API endpoints in development to inspect outbound webhook payloads end-to-end:
These endpoints are disabled in production (`NODE_ENV=production`).

- `POST /api/webhooks/dev/outbound` — receives and stores an event
- `GET /api/webhooks/dev/outbound/events` — lists captured events (latest first)
- `DELETE /api/webhooks/dev/outbound/events` — clears captured events

Example pipeline delivery target for local debug:

```yaml
output:
  from: summarize
  deliver:
    - type: webhook
      url: http://localhost:3001/api/webhooks/dev/outbound
      method: POST
      signing_secret_name: WEBHOOK_SIGNING_SECRET
```

### Stripe webhook (local)

```bash
stripe listen --forward-to localhost:3001/api/billing/stripe/webhook
```

## Master Key Rotation

Secrets are stored with envelope encryption and can be re-wrapped to a new master key.

1. Generate a new key (do not overwrite current key yet):

```bash
openssl rand -hex 32
```

2. Run a dry run:

```bash
ROTATE_OLD_MASTER_KEY="<current-64-hex>" \
ROTATE_NEW_MASTER_KEY="<new-64-hex>" \
ROTATE_NEW_KEY_VERSION=2 \
ROTATE_DRY_RUN=true \
bun run --filter @stepiq/api rotate:master-key
```

3. Run the real rotation:

```bash
ROTATE_OLD_MASTER_KEY="<current-64-hex>" \
ROTATE_NEW_MASTER_KEY="<new-64-hex>" \
ROTATE_NEW_KEY_VERSION=2 \
bun run --filter @stepiq/api rotate:master-key
```

4. Update runtime env (`STEPIQ_MASTER_KEY`) to the new key and restart API + worker.

## Dokploy Runbook (Rotation)

Recommended setup on Dokploy:
- API service env includes `STEPIQ_MASTER_KEY` (current key)
- Worker service env includes the same `STEPIQ_MASTER_KEY`
- Postgres and Redis envs are configured as usual

Rotation on Dokploy:
1. Open API service shell / one-off command runner.
2. Run dry run inside the API container:

```bash
ROTATE_OLD_MASTER_KEY="<current-64-hex>" \
ROTATE_NEW_MASTER_KEY="<new-64-hex>" \
ROTATE_NEW_KEY_VERSION=2 \
ROTATE_DRY_RUN=true \
bun run apps/api/dist/scripts/rotate-master-key.js
```

3. Run the real rotation (same command without `ROTATE_DRY_RUN=true`).
4. Update `STEPIQ_MASTER_KEY` in Dokploy env for **both API and worker** to the new key.
5. Redeploy/restart API and worker.

## License

GNU Affero General Public License v3.0 (AGPL-3.0-only)
