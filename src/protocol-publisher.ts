import type { AdvertisedSize, Placement, Publisher } from './types.js'
import {
  GEOMETRY_PROTOCOL_VERSION,
  type GeometryAddress,
  type GeometryBatch,
  type GeometryMessage,
  type PlacementMessage,
  type SizeMessage,
} from './protocol-types.js'

export type GeometrySend = Publisher<GeometryMessage>
export type GeometryBatchSend = Publisher<GeometryBatch>

export interface GeometryBatcherOptions {
  /** Observes every batch-delivery error, including explicit flushes; it must not throw. */
  onError?: (error: unknown) => void
}

export interface GeometryBatcher {
  /** Queues one message. Returns false after disposal. */
  publish(message: GeometryMessage): boolean
  /** Attempts delivery of the current latest-value snapshot; delivery errors return false. */
  flush(): boolean
  /** Forgets one anchor's state, or every anchor when omitted. */
  clear(anchorId?: string): void
  /** Clears pending state; already scheduled microtasks become inert. */
  dispose(): void
}

/**
 * Wraps placement updates in a versioned protocol message. Sequence numbers
 * start at 1 and increment with each attempted delivery.
 *
 * Keep one publisher per `{ anchorId, generation }` (e.g. via `useMemo` or `useRef`).
 * Batchers and sequence guards drop messages with older sequence numbers, so
 * recreating a publisher for the same address causes its messages to be dropped.
 * Increment `generation` when intentionally resetting the publisher.
 */
export function createPlacementMessagePublisher(
  address: GeometryAddress,
  send: GeometrySend,
): (placement: Placement) => boolean {
  let seq = 0

  return (placement) => {
    const message: PlacementMessage = {
      v: GEOMETRY_PROTOCOL_VERSION,
      kind: 'placement',
      anchorId: address.anchorId,
      generation: address.generation,
      seq: ++seq,
      placement,
    }
    return send(message) !== false
  }
}

/**
 * Wraps size updates in a versioned protocol message.
 * Follows the same stability rule: keep one publisher per `{ anchorId, generation }`,
 * and increment `generation` when resetting.
 */
export function createSizeMessagePublisher(
  address: GeometryAddress,
  send: GeometrySend,
): (size: AdvertisedSize) => boolean {
  let seq = 0

  return (size) => {
    const message: SizeMessage = {
      v: GEOMETRY_PROTOCOL_VERSION,
      kind: 'size',
      anchorId: address.anchorId,
      generation: address.generation,
      seq: ++seq,
      size,
    }
    return send(message) !== false
  }
}

/**
 * Coalesces same-task messages without adding a rendering-frame delay. It owns
 * no authorization policy: callers must associate addresses with trusted IPC
 * senders before accepting a delivered batch.
 */
export function createGeometryBatcher(
  send: GeometryBatchSend,
  options: GeometryBatcherOptions = {},
): GeometryBatcher {
  /** State is indexed by anchor so upgrades and clear(anchor) are O(1). */
  interface AnchorState {
    /** Generation, pending placement/size, and their accepted sequence marks. */
    g: number
    p?: PlacementMessage
    s?: SizeMessage
    pSeq?: number
    sSeq?: number
  }

  const anchors = new Map<string, AnchorState>()
  const pendingAnchors = new Set<AnchorState>()
  let disposed = false
  let scheduled = false
  let flushing = false

  function report(error: unknown): void {
    try {
      options.onError?.(error)
    } catch {
      // Error reporting must not turn scheduled delivery into an unhandled error.
    }
  }

  function flush(): boolean {
    if (disposed || flushing) return false
    const messages: GeometryMessage[] = []
    const snapshotStates: AnchorState[] = []
    for (const state of pendingAnchors) {
      if (state.p !== undefined) {
        messages.push(state.p)
        snapshotStates.push(state)
      }
      if (state.s !== undefined) {
        messages.push(state.s)
        snapshotStates.push(state)
      }
    }
    if (messages.length === 0) return false

    const batch: GeometryBatch = {
      v: GEOMETRY_PROTOCOL_VERSION,
      kind: 'batch',
      messages,
    }

    flushing = true
    try {
      let accepted: boolean
      try {
        accepted = send(batch) !== false
      } catch (error) {
        report(error)
        return false
      }
      if (!accepted) return false

      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!
        const state = anchors.get(message.anchorId)
        // A reentrant clear or generation upgrade replaces the state object.
        if (state === undefined || state !== snapshotStates[index]) continue
        if (message.kind === 'placement') {
          if (state.pSeq === undefined || message.seq > state.pSeq) {
            state.pSeq = message.seq
          }
          // Reentrant publishing may have replaced this message while send ran.
          if (state.p === message) state.p = undefined
        } else {
          if (state.sSeq === undefined || message.seq > state.sSeq) {
            state.sSeq = message.seq
          }
          if (state.s === message) state.s = undefined
        }
        if (state.p === undefined && state.s === undefined) {
          pendingAnchors.delete(state)
        }
      }
      return true
    } finally {
      flushing = false
    }
  }

  function schedule(): void {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) flush()
    })
  }

  return {
    publish(message) {
      if (disposed) return false
      let state = anchors.get(message.anchorId)
      if (state !== undefined && message.generation < state.g) return true
      if (state === undefined || message.generation > state.g) {
        if (state !== undefined) pendingAnchors.delete(state)
        state = {
          g: message.generation,
          p: undefined,
          s: undefined,
          pSeq: undefined,
          sSeq: undefined,
        }
        anchors.set(message.anchorId, state)
      }
      if (message.kind === 'placement') {
        if (
          (state.p === undefined || message.seq > state.p.seq) &&
          (state.pSeq === undefined || message.seq > state.pSeq)
        ) {
          state.p = message
          pendingAnchors.add(state)
          schedule()
        }
      } else if (
        (state.s === undefined || message.seq > state.s.seq) &&
        (state.sSeq === undefined || message.seq > state.sSeq)
      ) {
        state.s = message
        pendingAnchors.add(state)
        schedule()
      }
      return true
    },
    flush,
    clear(anchorId) {
      if (anchorId === undefined) {
        anchors.clear()
        pendingAnchors.clear()
        return
      }
      const state = anchors.get(anchorId)
      if (state !== undefined) pendingAnchors.delete(state)
      anchors.delete(anchorId)
    },
    dispose() {
      disposed = true
      anchors.clear()
      pendingAnchors.clear()
    },
  }
}
