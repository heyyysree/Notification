import type { WebSocket } from 'ws'

// ─────────────────────────────────────────────────────────────
// Why an interface in front of the connection store?
// Phase 1 uses an in-memory Map — fast and zero-dependency
// but not horizontally scalable. A delivery job arriving on
// Node A cannot reach a socket connected to Node B.
//
// Phase 2 replaces this with a Redis-backed store that uses
// pub/sub to forward delivery messages across nodes.
//
// The interface is the contract. The processor, dispatcher,
// and WS handler all depend only on IConnectionStore — they
// never import InMemoryConnectionStore directly. Phase 2 is
// a single constructor swap in the service factory, not a
// refactor across the codebase.
// ─────────────────────────────────────────────────────────────

export interface ConnectedSocket {
  userId:   string
  tenantId: string
  socket:   WebSocket
  connectedAt: Date
}

export interface IConnectionStore {
  // Registers a socket when a user connects
  add(userId: string, tenantId: string, socket: WebSocket): void

  // Removes a socket when a user disconnects
  remove(userId: string): void

  // Returns the socket for a userId, or null if not connected
  get(userId: string): ConnectedSocket | null

  // Returns true if the userId has an active connection
  isConnected(userId: string): boolean

  // Returns total count of open connections — for metrics
  size(): number

  // Returns all connections for a tenant — for broadcast
  getByTenant(tenantId: string): ConnectedSocket[]
}

// ─────────────────────────────────────────────────────────────
// Phase 1 implementation — in-memory, single process only
//
// Key properties:
// - O(1) get/add/remove by userId
// - O(n) getByTenant where n = connections for that tenant
//   (acceptable for Phase 1 broadcast; Phase 2 uses Redis sets)
// - No TTL — sockets are removed only on explicit disconnect
//   or on the 'close' event from the ws library
// ─────────────────────────────────────────────────────────────

export class InMemoryConnectionStore implements IConnectionStore {
  // Primary index: userId → socket
  private readonly byUserId = new Map<string, ConnectedSocket>()

  // Secondary index: tenantId → Set<userId>
  // Maintained in sync with byUserId for O(1) tenant-scoped lookups
  private readonly byTenantId = new Map<string, Set<string>>()

  add(userId: string, tenantId: string, socket: WebSocket): void {
    // If user reconnects before their old socket is cleaned up,
    // remove the old entry to avoid a stale reference.
    // This can happen on a rapid disconnect/reconnect where the
    // 'close' event hasn't fired yet on the old socket.
    if (this.byUserId.has(userId)) {
      this.remove(userId)
    }

    this.byUserId.set(userId, {
      userId,
      tenantId,
      socket,
      connectedAt: new Date(),
    })

    // Maintain tenant index
    if (!this.byTenantId.has(tenantId)) {
      this.byTenantId.set(tenantId, new Set())
    }
    this.byTenantId.get(tenantId)!.add(userId)
  }

  remove(userId: string): void {
    const entry = this.byUserId.get(userId)
    if (!entry) return

    this.byUserId.delete(userId)

    // Clean up tenant index
    const tenantSet = this.byTenantId.get(entry.tenantId)
    if (tenantSet) {
      tenantSet.delete(userId)
      if (tenantSet.size === 0) {
        this.byTenantId.delete(entry.tenantId)
      }
    }
  }

  get(userId: string): ConnectedSocket | null {
    return this.byUserId.get(userId) ?? null
  }

  isConnected(userId: string): boolean {
    return this.byUserId.has(userId)
  }

  size(): number {
    return this.byUserId.size
  }

  getByTenant(tenantId: string): ConnectedSocket[] {
    const userIds = this.byTenantId.get(tenantId)
    if (!userIds) return []

    return Array.from(userIds)
      .map(uid => this.byUserId.get(uid))
      .filter((c): c is ConnectedSocket => c !== undefined)
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 2 stub — documents the interface that Redis-backed
// store will implement. Shows exactly what changes in Phase 2.
// ─────────────────────────────────────────────────────────────

/*
export class RedisConnectionStore implements IConnectionStore {
  // add()    → HSET ws:conn:{tenantId}:{userId} nodeId connectionId
  //            SUBSCRIBE ws:notify:{userId} on this node
  // remove() → HDEL ws:conn:{tenantId}:{userId}
  //            UNSUBSCRIBE ws:notify:{userId}
  // get()    → local Map lookup only (cross-node delivery via pub/sub)
  // publish delivery to a userId:
  //   const nodeId = HGET ws:conn:{tenantId}:{userId} nodeId
  //   if nodeId === this.nodeId: deliver directly
  //   else: PUBLISH ws:notify:{userId} payload
  //   subscriber on target node receives and delivers to local socket
}
*/
