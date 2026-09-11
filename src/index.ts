/**
 * view-anchor: keeps an external surface aligned with a DOM element's geometry.
 */

export {
  createViewAnchor,
  measurePlacement,
  createPlacementAnchor,
} from './view-anchor.js'
export type {
  PlacementAnchorOptions,
  PlacementAnchorHandle,
} from './view-anchor.js'
export type {
  Bounds,
  Placement,
  Publisher,
  PublishResult,
  ViewAnchorOptions,
  ViewAnchorHandle,
} from './types.js'
export { createSizeAdvertiser } from './size-advertiser.js'
export { useViewAnchor } from './react.js'
export type {
  AdvertisedAxis,
  AdvertisedSize,
  SizeAdvertiserOptions,
  SizeAdvertiserHandle,
} from './types.js'
export type { UseViewAnchorOptions, ViewAnchorRef } from './react.js'
