import type { FastifyRequest, FastifyReply } from 'fastify'

// ─────────────────────────────────────────────────────────────────
// Static bearer-token authentication for the ingestion API.
//
// All POST /v1/events requests must include:
//   Authorization: Bearer <INGESTION_API_KEY>
//
// Why static key, not JWT?
// The ingestion API is called by trusted internal producers
// (your own services), not end-users. A shared secret is simpler
// to rotate and avoids token TTL management on the producer side.
// Rotate via environment variable re-injection (ECS, Kubernetes
// Secrets); both old and new keys can be accepted during rotation
// by checking against an array.
//
// IMPORTANT: `timingSafeEqual` is used for comparison to prevent
// timing oracle attacks — an attacker measuring response time
// could otherwise narrow down the correct key byte-by-byte.
// ─────────────────────────────────────────────────────────────────

import { timingSafeEqual } from 'crypto'

export async function bearerAuthHook(
  req:   FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = process.env['INGESTION_API_KEY']
  if (!apiKey) {
    req.log.error('INGESTION_API_KEY not set — rejecting all requests')
    return reply.code(503).send({ error: 'Service misconfigured' })
  }

  const authHeader = req.headers['authorization'] ?? ''

  if (!authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({
      error:   'Unauthorized',
      message: 'Authorization: Bearer <key> header required',
    })
  }

  const providedKey = authHeader.slice(7)

  // Pad both buffers to the same length before comparing.
  // timingSafeEqual requires equal-length Buffers.
  const a = Buffer.from(providedKey.padEnd(apiKey.length))
  const b = Buffer.from(apiKey)

  const lengthsMatch  = providedKey.length === apiKey.length
  const valuesMatch   = timingSafeEqual(a, b)

  if (!lengthsMatch || !valuesMatch) {
    req.log.warn({ ip: req.ip }, 'Invalid API key on ingestion request')
    return reply.code(401).send({
      error:   'Unauthorized',
      message: 'Invalid API key',
    })
  }
}
