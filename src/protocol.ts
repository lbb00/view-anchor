import type { AdvertisedSize, Placement } from './types.js'
import {
  GEOMETRY_PROTOCOL_VERSION,
  type GeometryAddress,
  type GeometryBatch,
  type GeometryMessage,
  type GeometryWireValue,
  type PlacementMessage,
  type SizeMessage,
} from './protocol-types.js'

export { GEOMETRY_PROTOCOL_VERSION }
export type {
  GeometryAddress,
  GeometryBatch,
  GeometryMessage,
  GeometryWireValue,
  PlacementMessage,
  SizeMessage,
}

export type GeometryDecodeResult =
  | { ok: true; value: GeometryWireValue }
  | { ok: false; error: string }

export interface GeometryDecodeOptions {
  /** Required caller-owned resource limit for a received batch. */
  maxMessages: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value >= 0

function error(message: string): GeometryDecodeResult {
  return { ok: false, error: message }
}

function decodePlacement(value: unknown): Placement | undefined {
  if (!isRecord(value) || typeof value.visible !== 'boolean') return undefined
  if (!value.visible) return { visible: false }
  if (!isRecord(value.bounds)) return undefined
  const { x, y, width, height } = value.bounds
  if (
    !isSafeInteger(x) ||
    !isSafeInteger(y) ||
    !isNonNegativeSafeInteger(width) ||
    !isNonNegativeSafeInteger(height)
  ) {
    return undefined
  }
  return { visible: true, bounds: { x, y, width, height } }
}

function decodeSize(value: unknown): AdvertisedSize | undefined {
  if (!isRecord(value)) return undefined
  if (value.axis !== 'block' && value.axis !== 'inline') return undefined
  if (!isNonNegativeSafeInteger(value.extent)) return undefined
  return { axis: value.axis, extent: value.extent }
}

function decodeMessage(value: unknown): GeometryMessage | undefined {
  if (!isRecord(value) || value.v !== GEOMETRY_PROTOCOL_VERSION) return undefined
  if (typeof value.anchorId !== 'string' || value.anchorId.length === 0) return undefined
  if (
    !isNonNegativeSafeInteger(value.generation) ||
    !isNonNegativeSafeInteger(value.seq)
  ) {
    return undefined
  }
  const address = {
    v: GEOMETRY_PROTOCOL_VERSION,
    anchorId: value.anchorId,
    generation: value.generation,
    seq: value.seq,
  }
  if (value.kind === 'placement') {
    const placement = decodePlacement(value.placement)
    return placement === undefined
      ? undefined
      : { ...address, kind: 'placement', placement }
  }
  if (value.kind === 'size') {
    const size = decodeSize(value.size)
    return size === undefined ? undefined : { ...address, kind: 'size', size }
  }
  return undefined
}

/**
 * Decodes untrusted transport data without throwing. `maxMessages` is required
 * so each receiver, rather than this library, chooses its own batch limit.
 */
export function decodeGeometryWireValue(
  value: unknown,
  options: GeometryDecodeOptions,
): GeometryDecodeResult {
  try {
    if (!isNonNegativeSafeInteger(options?.maxMessages) || options.maxMessages === 0) {
      return error('maxMessages must be a positive safe integer')
    }
    const message = decodeMessage(value)
    if (message !== undefined) return { ok: true, value: message }
    if (!isRecord(value) || value.v !== GEOMETRY_PROTOCOL_VERSION || value.kind !== 'batch') {
      return error('invalid geometry message')
    }
    if (!Array.isArray(value.messages) || value.messages.length > options.maxMessages) {
      return error('invalid geometry batch')
    }
    const messages: GeometryMessage[] = []
    for (const item of value.messages) {
      const decoded = decodeMessage(item)
      if (decoded === undefined) return error('invalid geometry batch member')
      messages.push(decoded)
    }
    return {
      ok: true,
      value: { v: GEOMETRY_PROTOCOL_VERSION, kind: 'batch', messages },
    }
  } catch {
    return error('invalid geometry message')
  }
}

export interface GeometrySequenceGuard {
  /** Returns whether this message is newer than the last accepted equivalent. */
  accept(message: GeometryMessage): boolean
  /** Forgets state for one anchor, or every anchor when omitted. */
  clear(anchorId?: string): void
}

// -1 means that this generation has not seen the corresponding message kind.
type GeometrySequenceState = [
  generation: number,
  placementSeq: number,
  sizeSeq: number,
]

/**
 * Keeps one generation floor per anchor and a sequence high-water mark per
 * message kind within that generation. Ordering metadata is not authority:
 * receivers must still authorize anchor IDs from their trusted transport
 * context before passing a message here.
 */
export function createGeometrySequenceGuard(): GeometrySequenceGuard {
  const latest = new Map<string, GeometrySequenceState>()

  return {
    accept(message) {
      const current = latest.get(message.anchorId)
      if (current === undefined || message.generation > current[0]) {
        latest.set(
          message.anchorId,
          [
            message.generation,
            message.kind === 'placement' ? message.seq : -1,
            message.kind === 'size' ? message.seq : -1,
          ],
        )
        return true
      }
      if (message.generation < current[0]) return false
      const sequenceIndex = message.kind === 'placement' ? 1 : 2
      if (message.seq <= current[sequenceIndex]) return false
      current[sequenceIndex] = message.seq
      return true
    },
    clear(anchorId) {
      if (anchorId === undefined) {
        latest.clear()
        return
      }
      latest.delete(anchorId)
    },
  }
}

export {
  createGeometryBatcher,
  createPlacementMessagePublisher,
  createSizeMessagePublisher,
} from './protocol-publisher.js'
export type {
  GeometryBatcher,
  GeometryBatcherOptions,
  GeometryBatchSend,
  GeometrySend,
} from './protocol-publisher.js'
