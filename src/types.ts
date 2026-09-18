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
export type Placement = { visible: true; bounds: Bounds } | { visible: false }

// --- Reverse direction: size anchor ---
//
// Runs in a downstream document to report content size back to the host,
// allowing the host's DOM placeholder to match the content.

/** Which axis this size anchor reports: 'block' (height) or 'inline' (width). */
export type SizeAxis = 'block' | 'inline'

/** One measured size on the owned axis. */
export interface SizeMeasurement {
  /** The axis this size anchor reports ('block' or 'inline'). */
  readonly axis: SizeAxis
  /**
   * The target's border-box size on this axis in CSS pixels, rounded and
   * non-negative. Falls back to the content box where no border box is reported.
   */
  readonly extent: number
}

export interface SizeAnchorOptions {
  /** The single axis this size anchor owns. Fixed for its lifetime. */
  axis: SizeAxis
  /** Receives each measured size. */
  publish: Publisher<SizeMeasurement>
  /** Stops this size anchor when aborted. An already-aborted signal starts no work. */
  signal?: AbortSignal
  /**
   * When true (the default), a measurement identical to the last published
   * extent is not published again. When false, every measurement publishes,
   * even an unchanged extent. Omitting it in update() resets to true.
   */
  dedupe?: boolean
}

export interface SizeAnchorHandle {
  /**
   * Apply a full set of options and re-publish the current size
   * immediately. Like creation, an omitted dedupe resets to true.
   */
  update(opts: Omit<SizeAnchorOptions, 'signal' | 'axis'>): void
  /** Stop observing and cancel any pending animation frame. */
  dispose(): void
}
