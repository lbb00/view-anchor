import type { SizeMeasurement, Placement } from './types.js'

/**
 * Wire-format shapes shared by `protocol.ts` (decode/guard) and
 * `protocol-publisher.ts` (encode/batch). Kept here to break a value
 * import cycle between those two files.
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
  size: SizeMeasurement
}

export type GeometryMessage = PlacementMessage | SizeMessage

export interface GeometryBatch {
  v: typeof GEOMETRY_PROTOCOL_VERSION
  kind: 'batch'
  messages: readonly GeometryMessage[]
}

export type GeometryWireValue = GeometryMessage | GeometryBatch
