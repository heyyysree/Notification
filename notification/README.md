# Notification Engine

A multi-tenant, multi-channel notification delivery platform built on PostgreSQL, Redis, and BullMQ. Events enter through the ingestion API and fan out across three delivery channels: WebSocket, webhook, and (future) push notification.

---

## Architecture

```
                         ┌─────────────────────────────────────────────────┐
                         │                   Turborepo Monorepo             │
                         │                                                   │
  External Event         │  ┌──────────────┐     ┌──────────────────────┐  │
  Producers  ──────────► │  │ ingestion-api│────►│      fan-out         │  │
  (POST /events)         │  │  :3000       │     │  (BullMQ worker)     │  │
                         │  └──────────────┘     └──────┬───────────────┘  │
                         │                              │                   │
                         │               ┌──────────────┼──────────────┐   │
                         │               ▼              ▼              ▼   │
                         │  ┌────────────────┐ ┌──────────────┐ ┌────────┐│
                         │  │  ws-gateway    │ │webhook-service│ │ push  ││
                         │  │  :3002         │ │ (BullMQ worker│ │(future││
                         │  │  BullMQ worker │ │ HMAC-SHA256)  │ │       ││
                         │  └────────┬───────┘ └──────────────┘ └────────┘│
                         │           │                                      │
                         │  ┌────────▼───────────────────────────────────┐ │
                         │  │            @notification-engine/shared      │ │
                         │  │  Types · Queue names · Redis keys · Env     │ │
                         │  └────────────────────────────────────────────┘ │
                         └─────────────────────────────────────────────────┘
                                   │                    │
                              PostgreSQL             Redis
                             (deliveries,         (BullMQ queues,
                              events,             dedup keys,
                              subscriptions,      circuit breakers,
                              webhooks)           WS presence)
```

### Services

| Service | Description | Queue |
|---|---|---|
| **ingestion-api** | Receives events via authenticated HTTP POST, validates, deduplicates on `eventId`, enqueues fan-out jobs | Producer |
| **fan-out** | Queries subscriptions for `(tenantId, eventType)`, creates delivery rows, routes by channel | Consumes `notification:fan-out` |
| **ws-gateway** | Serves WebSocket connections; co-located BullMQ worker delivers to connected sockets | Consumes `notification:ws-delivery` |
| **webhook-service** | Makes signed HTTP POST calls to tenant-configured URLs; implements circuit breaker | Consumes `notification:webhook-delivery` |
| **@notification-engine/shared** | Shared types, queue constants, Redis key patterns, Zod env schemas, Redis/DB utilities | Library |

---

## Key Design Decisions

### 1. IConnectionStore interface (Phase 1 → Phase 2 swap)

The WebSocket connection store sits behind an interface:

```typescript
export interface IConnectionStore {
  add(userId: string, tenantId: string, socket: WebSocket): void
  remove(userId: string): void
  get(userId: string): ConnectedSocket | null
  isConnected(userId: string): boolean
  size(): number
  getByTenant(tenantId: string): ConnectedSocket[]
}
```

**Phase 1** (`InMemoryConnectionStore`) uses a plain `Map`. Works on a single node. The co-located BullMQ worker calls `connectionStore.get(userId)` directly to retrieve the socket object.

**Phase 2** (`RedisConnectionStore`, not yet implemented) publishes delivery messages via Redis pub/sub. Every gateway node subscribes to `ws:notify:{userId}`. Only the node holding the socket delivers; all others ignore the message. The interface is the contract — Phase 2 is a single constructor swap in `index.ts`, not a refactor across the codebase.

---

### 2. Redis dedup before DB update

The delivery processor executes steps in this exact order:

```
1. GET dedup:{channel}:{eventId}:{userId}   ← Redis (fast pre-check)
2. Look up socket in connection store
3. socket.send(JSON)                        ← WebSocket write
4. SET dedup:{channel}:{eventId}:{userId} EX 86400   ← BEFORE DB update
5. UPDATE deliveries SET status = 'sent'
```

Setting the dedup key **before** the DB update ensures crash-safety: if the process dies between steps 4 and 5, a BullMQ retry hits step 1 and deduplicates. If the process dies between steps 3 and 4, the retry re-sends — the correct fallback (better to deliver twice than silently skip).

The DB also has a `UNIQUE (event_id, user_id, channel)` constraint as a last-resort guard if Redis is temporarily unavailable and two job retries race.

---

### 3. Lazy secret read

`TokenAuthService.sign()` reads `process.env['WS_TOKEN_SECRET']` **inside the method body**, not at module load time:

```typescript
private sign(body: string): string {
  const secret = process.env['WS_TOKEN_SECRET'] ?? 'dev-secret-change-in-production'
  return createHmac('sha256', secret).update(body).digest('base64url')
}
```

Module-level code executes when the module is first imported, which happens before `main()` calls `loadEnv()`. Reading the secret at module level would see `undefined` for env vars that come from `.env` files, silently falling back to the insecure default. Reading lazily inside the function guarantees correctness regardless of import order.

---

### 4. Store-before-enqueue ordering (fan-out service)

The fan-out service follows this order when creating a delivery:

```
1. INSERT INTO deliveries (status = 'pending')
2. Queue.add(WsDeliveryJobPayload)           ← AFTER the INSERT
```

If steps were reversed and the process crashed between enqueue and insert, the worker would process a job for a delivery row that doesn't exist — a foreign key violation or silent no-op. By inserting first, the delivery row always exists when the worker runs, and BullMQ retries can safely re-attempt the same job ID.

---

### 5. Three-state delivery idempotency

Delivery rows transition through three terminal states:

| Status | Meaning |
|---|---|
| `pending` | Enqueued; not yet attempted |
| `sent` | Notification reached the client's socket |
| `failed` | All attempts exhausted; user was not connected, or socket write failed |
| `deduped` | Redis dedup key indicated this was already sent within 24 h |

All `UPDATE` statements include terminal-state guards so retries are no-ops:

```sql
-- markSent — skips if already sent or deduped
UPDATE deliveries SET status = 'sent', sent_at = NOW()
 WHERE id = $1 AND status NOT IN ('sent', 'deduped')

-- markFailed — skips if already in a terminal state
UPDATE deliveries SET status = 'failed', error = $2
 WHERE id = $1 AND status NOT IN ('sent', 'failed', 'deduped')
```

---

### 6. Sliding-window rate limiting on WebSocket upgrades

`ConnectionRateLimiter` tracks per-IP connection timestamps in a `Map<string, number[]>`. On each upgrade request it removes timestamps older than `windowMs`, counts the remainder, and rejects if `count >= maxConnections`.

```typescript
isAllowed(ip: string): boolean {
  const now = Date.now()
  const inWindow = (this.windows.get(ip) ?? []).filter(ts => ts > now - this.windowMs)
  if (inWindow.length >= this.maxConnections) {
    this.windows.set(ip, inWindow)
    return false
  }
  inWindow.push(now)
  this.windows.set(ip, inWindow)
  return true
}
```

**Why sliding vs fixed window?** A fixed window resets on the clock boundary. An attacker can exhaust the limit at the end of window N and again at the start of window N+1 — effectively doubling the burst. A sliding window's effective rate is always bounded to the true window duration.

**Why before the WS handshake?** The gateway uses `noServer: true` + a manual `httpServer.on('upgrade')` handler. This means rate limiting (and path filtering) runs **before** the ws library completes the HTTP upgrade. If the server option were passed directly to `WebSocketServer`, the upgrade would already be accepted before we could send an HTTP 429 — we'd have to close the already-open WebSocket instead.

```typescript
httpServer.on('upgrade', (req, socket, head) => {
  if (pathname !== '/ws') { socket.destroy(); return }

  if (!rateLimiter.isAllowed(ip)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
```

**Phase 2 upgrade path:** Replace `isAllowed()` with a Lua script that does `ZADD` / `ZREMRANGEBYSCORE` / `ZCARD` / `EXPIRE` atomically, enforcing the limit across the full fleet.

---

### 7. HMAC-SHA256 webhook signing

Each outbound webhook POST includes a signature header:

```
X-Webhook-Signature: sha256=<hex-digest>
```

The digest is `HMAC-SHA256(requestBody, secret)` where `secret` is fetched from the key reference stored in the webhook configuration row (`secretId`). Secrets are never stored in the DB — only the key reference is.

Recipients verify by recomputing the HMAC and comparing with `timingSafeEqual` to prevent timing oracles.

---

### 8. Circuit breaker for webhook delivery

The webhook service tracks consecutive failures per webhook configuration in Redis:

```
Key: circuit:{webhookId}   Value: failure count   TTL: WEBHOOK_CIRCUIT_BREAK_RESET_MS
```

When `count >= WEBHOOK_CIRCUIT_BREAK_THRESHOLD` (default: 5), the circuit "opens" and subsequent delivery attempts are rejected immediately without an outbound HTTP call. The key expires after `WEBHOOK_CIRCUIT_BREAK_RESET_MS` (default: 60s), at which point the circuit "half-opens" and the next attempt probes the endpoint.

On a successful delivery, the key is deleted to reset the counter.

---

### 9. WebSocket close/error race condition guard

When a user rapidly reconnects, `connectionStore.add()` in the new handler replaces the old store entry before the old socket's `'close'` event fires. Without a guard, the old socket's `'close'` handler would remove the **new** connection:

```typescript
// Guard: only remove this userId if the store still maps it to THIS socket
socket.on('close', (code, reason) => {
  const current = this.connectionStore.get(userId)
  if (current?.socket === socket) {   // ← identity check, not userId check
    this.connectionStore.remove(userId)
  }
})
```

The same guard is applied on the `'error'` handler.

---

## Project Structure

```
notification-engine/
├── package.json              # Workspace root (Turborepo)
├── turbo.json                # Turborepo pipeline
├── tsconfig.base.json        # Shared TypeScript config
│
├── packages/
│   └── shared/               # @notification-engine/shared
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts      # Types, queue names, Redis keys, env schemas
│
└── services/
    └── ws-gateway/           # WebSocket delivery service (Phase 1)
        ├── package.json
        ├── tsconfig.json
        ├── index.ts          # Entry point — server setup, shutdown
        ├── connection/
        │   ├── connection-store.ts      # IConnectionStore interface + InMemoryConnectionStore
        │   └── ws-connection-handler.ts # Auth, store registration, message dispatch
        ├── lib/
        │   ├── errors.ts     # GatewayError, WS_CLOSE_CODES (4001, 4002, 4029, 4500)
        │   ├── logger.ts     # Pino structured logger
        │   └── rate-limiter.ts # Sliding-window per-IP rate limiter
        ├── processors/
        │   └── ws-delivery.processor.ts # Dedup check, socket send, DB update
        ├── repositories/
        │   └── delivery.repository.ts  # markSent, markFailed, markDeduped
        ├── routes/
        │   └── health.route.ts  # GET /health, GET /ready
        ├── services/
        │   ├── heartbeat.service.ts    # Ping/pong — detects half-open connections
        │   └── token-auth.service.ts   # HMAC token issue + verify
        └── workers/
            └── ws-delivery.worker.ts  # BullMQ worker — co-located with WS server
```

---

## Running Locally

### Prerequisites

- Node.js >= 20
- PostgreSQL 15+
- Redis 7+
- `npm` (workspace support built in)

### Setup

```bash
# 1. Install all workspace dependencies from the repo root
npm install

# 2. Copy and edit environment variables
cp services/ws-gateway/.env.example services/ws-gateway/.env
# Edit DATABASE_URL, REDIS_URL, and WS_TOKEN_SECRET at minimum

# 3. Start PostgreSQL and Redis (Docker example)
docker run -d --name pg   -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:15
docker run -d --name redis -p 6379:6379 redis:7

# 4. Run database migrations
psql "$DATABASE_URL" -f services/ws-gateway/db/migrations/001_initial_schema.sql

# 5. Build the shared package first (other services depend on it)
npm run build -w packages/shared

# 6. Start the ws-gateway in dev mode (watch + restart on change)
npm run dev -w services/ws-gateway
```

### Verify

```bash
# Liveness
curl http://localhost:3002/health
# {"status":"ok","service":"ws-gateway","connections":0,"uptime":3,"timestamp":"..."}

# Readiness
curl http://localhost:3002/ready
# {"ready":true,"connections":0}

# WebSocket connection (requires a valid signed token)
# Generate a dev token:
npx ts-node -e "
  const { TokenAuthService } = require('./services/ws-gateway/src/services/token-auth.service')
  const svc = new TokenAuthService()
  console.log(svc.issueToken({ userId: 'usr_1', tenantId: 'ten_1' }))
"
# Then connect:
wscat -c 'ws://localhost:3002/ws?token=<TOKEN>'
```

---

## Running Tests

Tests use [Testcontainers](https://testcontainers.com/) to spin up real PostgreSQL and Redis instances — no mocks, no local infrastructure required beyond Docker.

```bash
# All tests across all packages
npm test

# Just one service
npm test -w services/ws-gateway

# Watch mode
npm run test:watch -w services/ws-gateway
```

> **Note:** First run pulls Docker images. Subsequent runs reuse them. Set `TESTCONTAINERS_RYUK_DISABLED=true` in CI to skip the Ryuk reaper container.

---

## Environment Variables

### Shared (all services)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `LOG_LEVEL` | No | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string |
| `REDIS_URL` | **Yes** | — | Redis connection URL |

### ws-gateway

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3002` | HTTP/WS listen port |
| `WS_TOKEN_SECRET` | **Yes** | — | HMAC-SHA256 secret (min 32 chars). Generate: `openssl rand -hex 32` |
| `WS_NODE_ID` | No | `node-<pid>` | Unique identifier for this gateway instance (used in Phase 2 presence keys) |
| `WS_HEARTBEAT_MS` | No | `30000` | Milliseconds between WebSocket ping frames |
| `WS_RATE_LIMIT_MAX` | No | `20` | Max new WS connections per IP per window |
| `WS_RATE_LIMIT_WINDOW_MS` | No | `60000` | Sliding window duration for rate limiting (ms) |
| `WS_WORKER_CONCURRENCY` | No | `50` | BullMQ worker concurrency — tune per available memory |

### fan-out

| Variable | Required | Default | Description |
|---|---|---|---|
| `FAN_OUT_CONCURRENCY` | No | `20` | BullMQ worker concurrency |

### webhook-service

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEBHOOK_CONCURRENCY` | No | `10` | BullMQ worker concurrency |
| `WEBHOOK_TIMEOUT_MS` | No | `30000` | Per-request HTTP timeout (ms) |
| `WEBHOOK_CIRCUIT_BREAK_THRESHOLD` | No | `5` | Consecutive failures before circuit opens |
| `WEBHOOK_CIRCUIT_BREAK_RESET_MS` | No | `60000` | TTL on circuit breaker key — half-open after this (ms) |

### ingestion-api

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP listen port |
| `INGESTION_API_KEY` | **Yes** | — | Static bearer token for event ingestion (min 32 chars) |

---

## WebSocket Protocol

### Authentication

Pass a signed token as either:
- Query param: `ws://host:3002/ws?token=<TOKEN>`
- Header: `Authorization: Bearer <TOKEN>` (server-side clients)

**Token format:** `base64url(JSON) . HMAC-SHA256-signature`

**Payload:** `{ userId: UUID, tenantId: UUID, exp: UnixTimestamp }`

Default TTL: 5 minutes. Tokens are one-time use per connection — issue a new one for each reconnect.

### Close codes

| Code | Meaning |
|---|---|
| `4001` | Auth failed (bad token, invalid signature, malformed) |
| `4002` | Auth expired (token TTL elapsed) |
| `4029` | Rate limited (too many connections from this IP) |
| `4500` | Internal gateway error |
| `1001` | Server restarting — reconnect to another instance |

### Messages

**Server → Client**

```jsonc
// Sent immediately after successful auth
{ "type": "connected", "userId": "...", "timestamp": "..." }

// Notification delivery
{
  "type":       "notification",
  "deliveryId": "...",
  "eventId":    "...",
  "eventType":  "order.shipped",
  "payload":    { /* event-specific data */ },
  "timestamp":  "2024-01-01T00:00:00.000Z"
}
```

**Client → Server**

```jsonc
// Delivery acknowledgement (logged; future: triggers DB update)
{ "type": "ack", "deliveryId": "..." }
```

---

## Production Checklist

- [ ] `WS_TOKEN_SECRET` is at least 32 random bytes (`openssl rand -hex 32`)
- [ ] `INGESTION_API_KEY` is rotated per environment
- [ ] `NODE_ENV=production` (disables pino-pretty, enables JSON logs)
- [ ] `LOG_LEVEL=info` or `warn` (not `debug` — high-volume WS events are noisy)
- [ ] PostgreSQL `DATABASE_URL` uses a connection pooler (PgBouncer) in front of the DB
- [ ] Redis `REDIS_URL` points to a Redis Cluster or Sentinel setup for HA
- [ ] Health check endpoints (`/health`, `/ready`) are wired to your load balancer
- [ ] `WS_NODE_ID` is set to a unique value per replica (e.g., pod name in Kubernetes)
- [ ] Graceful shutdown (SIGTERM) drains workers before the process exits (30s watchdog)
- [ ] Circuit breaker thresholds (`WEBHOOK_CIRCUIT_BREAK_THRESHOLD`) are tuned per vendor SLA
