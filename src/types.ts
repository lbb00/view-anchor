/**
 * Core geometry and transport types for view-anchor.
 */

/** A screen-space rectangle in CSS pixels. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Returning false declines a value; true and void accept it. */
export type PublishResult = void | boolean

/**
 * Synchronous publish callback. A batching transport returns true once
 * the value is queued; subsequent delivery is handled by the transport.
 */
export type Publisher<T> = (value: T) => PublishResult

/**
 * Explicit visibility and bounds for an anchored view.
 *
 * Distinguishes an intentionally visible but zero-sized element ({ visible: true, bounds: 0x0 })
 * from a hidden or detached element ({ visible: false }).
 */
export type Placement =
  | { visible: true; bounds: Bounds }
  | { visible: false }

export interface ViewAnchorOptions {
  /**
   * Whether the native view should be attached. When false, publishes
   * zero bounds ({ x: 0, y: 0, width: 0, height: 0 }) so the host can detach
   * the view while keeping its instance alive.
   */
  present: boolean
  /** Receives the live rect, or zero bounds when detached. */
  publish: Publisher<Bounds>
}

export interface ViewAnchorHandle {
  /** Apply new options and re-publish immediately. */
  update(opts: ViewAnchorOptions): void
  /** Stop observing and clean up listeners. After disposal no further values are published. */
  dispose(): void
}

// --- Reverse direction: size advertiser ---
//
// Runs in a downstream document to report content size back to the host,
// allowing the host's DOM placeholder to match the content.

/** Which axis this advertiser reports: 'block' (height) or 'inline' (width). */
export type AdvertisedAxis = 'block' | 'inline'

/** One frame of advertised size on the owned axis. */
export interface AdvertisedSize {
  /** The axis this advertiser reports ('block' or 'inline'). */
  readonly axis: AdvertisedAxis
  /** The content extent in CSS pixels, rounded and non-negative. */
  readonly extent: number
}

export interface SizeAdvertiserOptions {
  /** The single axis this advertiser owns. Fixed for the advertiser's lifetime. */
  axis: AdvertisedAxis
  /** Receives each advertised size. */
  publish: Publisher<AdvertisedSize>
}

export interface SizeAdvertiserHandle {
  /** Swap the publish callback and re-advertise the current size immediately. */
  update(publish: Publisher<AdvertisedSize>): void
  /** Stop observing and cancel any pending animation frame. */
  dispose(): void
}
