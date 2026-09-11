import type { AdvertisedSize, Placement } from './types.js'

/**
 * Leaf module for the wire-format shapes shared by `protocol.ts` (decode/guard)
 * and `protocol-publisher.ts` (encode/batch). Keeping them here — rather than
 * in either of those two — avoids a value import cycle: `protocol.ts`
 * re-exports `protocol-publisher.ts`'s functions, and those functions need
 * `GEOMETRY_PROTOCOL_VERSION`, so neither of those two files can be the
 * source of it without the other importing back from it.
 */

/** Current wire format version for geometry messages. */
export const GEOMETRY_PROTOCOL_VERSION = 1 as const

/** Identifies one logical anchor instance within a transport session. */
export interface GeometryAddress {
  anchorId: string
  generation: number
}

export interface PlacementMessage extends GeometryAddress {
  v: typeof GEOMETRY_PROTOCOL_VERSION
  kind: 'placement'
  seq: number
  placement: Placement
}

export interface SizeMessage extends GeometryAddress {
  v: typeof GEOMETRY_PROTOCOL_VERSION
  kind: 'size'
  seq: number
  size: AdvertisedSize
}

export type GeometryMessage = PlacementMessage | SizeMessage

export interface GeometryBatch {
  v: typeof GEOMETRY_PROTOCOL_VERSION
  kind: 'batch'
  messages: readonly GeometryMessage[]
}

export type GeometryWireValue = GeometryMessage | GeometryBatch
