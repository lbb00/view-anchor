import type {
  Bounds,
  Placement,
  Publisher,
  ViewAnchorOptions,
  ViewAnchorHandle,
} from './types.js'

const ZERO: Bounds = { x: 0, y: 0, width: 0, height: 0 }

// Round to integer pixels. Width and height are clamped to >= 0 (0 represents
// a collapsed rect). Coordinates (x, y) can be negative when an element is
// scrolled out of view; clamping them to 0 would pin the view to the screen edge.
const clampRect = (r: {
  x: number
  y: number
  width: number
  height: number
}): Bounds => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.max(0, Math.round(r.width)),
  height: Math.max(0, Math.round(r.height)),
})

/**
 * Bind a native view or external surface to the geometry of `target`.
 *
 * - `present === true`: measures `target.getBoundingClientRect()` and publishes
 *   immediately, then re-measures synchronously on ResizeObserver and window resize.
 * - `present === false`: publishes a zero rect ({ x: 0, y: 0, width: 0, height: 0 })
 *   and stops observing.
 * - `update(opts)`: re-applies options immediately.
 * - `dispose()`: stops observing and prevents any further publishes.
 *
 * Synchronous publishing: measurement and publishing occur directly in the
 * observer tick. Cross-process setBounds calls already have a compositor delay;
 * adding requestAnimationFrame would add a second frame of visual lag during drag
 * operations. High-frequency updates are deduplicated against the last accepted rect.
 */
export function createViewAnchor(
  target: HTMLElement,
  opts: ViewAnchorOptions,
): ViewAnchorHandle {
  let present = opts.present
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  // Last rect sent to publish. Reset on apply() so state changes (such as zoom)
  // force a re-publish even if the geometry did not change.
  let lastPublished: Bounds | null = null
  let publicationRevision = 0
  let disposed = false

  const measure = (): Bounds | null => {
    const r = target.getBoundingClientRect()
    // Drop ticks with non-finite values (NaN / Infinity cannot be sent over IPC).
    if (
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height)
    ) return null
    return clampRect({ x: r.left, y: r.top, width: r.width, height: r.height })
  }

  const sameRect = (a: Bounds, b: Bounds): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  const publishCandidate = (candidate: Bounds): boolean => {
    const previous = lastPublished
    const attempt = ++publicationRevision
    lastPublished = candidate
    try {
      const accepted = publish(candidate) !== false
      if (!accepted && publicationRevision === attempt) lastPublished = previous
      return accepted
    } catch (error) {
      if (publicationRevision === attempt) lastPublished = previous
      throw error
    }
  }

  // Measure and publish synchronously on each observer tick.
  // Drops duplicate rects to coalesce same-frame resize events.
  const emit = (): void => {
    if (disposed || !present) return
    const m = measure()
    if (!m) return
    if (lastPublished && sameRect(lastPublished, m)) return
    publishCandidate(m)
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(emit)
    observer.observe(target)
    window.addEventListener('resize', emit)
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    window.removeEventListener('resize', emit)
  }

  // Apply current options synchronously. Reset lastPublished so state changes
  // always re-publish even if dimensions have not changed.
  const apply = (): void => {
    lastPublished = null
    if (present) {
      startObserving()
      const measured = measure()
      if (measured) publishCandidate(measured)
    } else {
      stopObserving()
      publishCandidate(ZERO)
    }
  }

  apply()

  return {
    update(next: ViewAnchorOptions): void {
      if (disposed) return
      publish = next.publish
      present = next.present
      apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopObserving()
    },
  }
}

// --- Explicit Placement API ---

export interface PlacementAnchorOptions {
  /**
   * Whether the native view should be visible. When true, publishes
   * { visible: true, bounds }; when false, publishes { visible: false }.
   */
  visible: boolean
  /** Receives each explicit Placement. */
  publish: Publisher<Placement>
  /**
   * When true, targets with zero area (such as display: none or unmounted elements)
   * publish { visible: false } instead of { visible: true, bounds: 0x0 }, and an
   * IntersectionObserver tracks display: none transitions. Default is false.
   * Sticky across update(): omitting it preserves the current setting.
   */
  guardDisplayNone?: boolean
  /**
   * When true, listens for capture-phase scroll events on window to re-measure
   * when an ancestor container scrolls. Default is false.
   * Sticky across update(): omitting it preserves the current setting.
   */
  followScroll?: boolean
  /**
   * When true, polls geometry per animation frame during active motion (scrolls,
   * splitter dragging, or pulse()) and auto-closes when steady. Zero idle overhead.
   * Sticky across update(): omitting it preserves the current setting.
   */
  followGeometry?: boolean
}

export interface PlacementAnchorHandle {
  /**
   * Apply new options and re-publish immediately.
   * guardDisplayNone, followScroll, and followGeometry are sticky: omitting a flag
   * preserves its current value. Pass an explicit false to disable one.
   */
  update(opts: PlacementAnchorOptions): void
  /** Stop observing; never publish again. */
  dispose(): void
  /**
   * Open the animation frame sentinel window. Auto-closes once stable
   * or after durationMs. No-op if followGeometry is false.
   */
  pulse(durationMs?: number): void
}

/**
 * Read target's current rect and return { visible: true, bounds }.
 * Does not infer visibility from dimensions.
 */
export function measurePlacement(target: HTMLElement): Placement {
  const r = target.getBoundingClientRect()
  return {
    visible: true,
    bounds: clampRect({ x: r.left, y: r.top, width: r.width, height: r.height }),
  }
}

const samePlacement = (a: Placement, b: Placement): boolean => {
  if (a.visible !== b.visible) return false
  if (a.visible && b.visible) {
    return (
      a.bounds.x === b.bounds.x &&
      a.bounds.y === b.bounds.y &&
      a.bounds.width === b.bounds.width &&
      a.bounds.height === b.bounds.height
    )
  }
  return true
}

/**
 * Explicit-visibility variant of createViewAnchor.
 */
export function createPlacementAnchor(
  target: HTMLElement,
  opts: PlacementAnchorOptions,
): PlacementAnchorHandle {
  let visible = opts.visible
  let publish = opts.publish
  let guardDisplayNone = opts.guardDisplayNone ?? false
  let followScroll = opts.followScroll ?? false
  let followGeometry = opts.followGeometry ?? false
  let observer: ResizeObserver | null = null
  let io: IntersectionObserver | null = null
  let scrollListening = false
  let geometryListening = false
  const capture = { capture: true }
  const passiveCapture = { capture: true, passive: true }
  let lastPublished: Placement | null = null
  let publicationRevision = 0
  let disposed = false

  // --- Windowed RAF geometry sentinel state ---
  // The sentinel polls per frame during active movement and auto-closes once
  // geometry settles. While closed, no frame is scheduled (zero idle overhead).
  let rafId: number | null = null
  let steadyFrames = 0
  const STEADY_CLOSE_FRAMES = 2
  const MAX_HIDDEN_FOLLOW_FRAMES = 30
  const MAX_INVALID_FOLLOW_FRAMES = 30
  let invalidFrames = 0
  // True while a [role="separator"] splitter drag is held.
  let pointerHeld = false
  let activePointerId: number | undefined | null = null
  let sentinelDeadline: number | null = null

  const computePlacement = (): Placement | null => {
    const p = measurePlacement(target)
    if (
      p.visible &&
      (!Number.isFinite(p.bounds.x) ||
        !Number.isFinite(p.bounds.y) ||
        !Number.isFinite(p.bounds.width) ||
        !Number.isFinite(p.bounds.height))
    ) return null
    if (
      guardDisplayNone &&
      p.visible &&
      (p.bounds.width === 0 || p.bounds.height === 0)
    ) {
      return { visible: false }
    }
    return p
  }

  const publishCandidate = (candidate: Placement): boolean => {
    const previous = lastPublished
    const attempt = ++publicationRevision
    lastPublished = candidate
    try {
      const accepted = publish(candidate) !== false
      if (!accepted && publicationRevision === attempt) lastPublished = previous
      return accepted
    } catch (error) {
      if (publicationRevision === attempt) lastPublished = previous
      throw error
    }
  }

  const emit = (): void => {
    if (disposed || !visible) return
    const p = computePlacement()
    if (!p) return
    if (lastPublished && samePlacement(lastPublished, p)) return
    publishCandidate(p)
  }

  const shouldCloseOnHiddenPoll = (): boolean => {
    if (lastPublished?.visible === false) return true
    return steadyFrames++ >= MAX_HIDDEN_FOLLOW_FRAMES
  }

  const sentinelFrame = (): void => {
    rafId = null
    if (disposed || !visible) {
      sentinelDeadline = null
      return
    }
    if (sentinelDeadline !== null && performance.now() >= sentinelDeadline) {
      sentinelDeadline = null
      return
    }
    const p = computePlacement()
    if (!p) {
      if (invalidFrames++ >= MAX_INVALID_FOLLOW_FRAMES) {
        sentinelDeadline = null
        return
      }
      if (!disposed && visible && followGeometry) {
        rafId = requestAnimationFrame(sentinelFrame)
      } else {
        sentinelDeadline = null
      }
      return
    }
    invalidFrames = 0
    if (!p.visible) {
      if (shouldCloseOnHiddenPoll()) { sentinelDeadline = null; return }
      if (!disposed && visible && followGeometry) {
        rafId = requestAnimationFrame(sentinelFrame)
      } else {
        sentinelDeadline = null
      }
      return
    }
    if (lastPublished && samePlacement(lastPublished, p)) {
      steadyFrames++
      if (steadyFrames >= STEADY_CLOSE_FRAMES && !pointerHeld) {
        sentinelDeadline = null
        return
      }
    } else {
      publishCandidate(p)
      steadyFrames = 0
    }
    if (!disposed && visible && followGeometry) {
      rafId = requestAnimationFrame(sentinelFrame)
    } else {
      sentinelDeadline = null
    }
  }

  const openSentinel = (): void => {
    if (!followGeometry || disposed) return
    steadyFrames = 0
    if (rafId === null) {
      invalidFrames = 0
      rafId = requestAnimationFrame(sentinelFrame)
    }
  }

  const closeSentinel = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    steadyFrames = 0
    invalidFrames = 0
    sentinelDeadline = null
    pointerHeld = false
    activePointerId = null
  }

  const onScroll = (): void => {
    if (followGeometry) openSentinel()
    else emit()
  }

  const onPointerDown = (e: Event): void => {
    const t = e.target as Element | null
    if (t && t.closest && t.closest('[role="separator"]')) {
      if (!pointerHeld) activePointerId = (e as PointerEvent).pointerId
      pointerHeld = true
      openSentinel()
    }
  }

  const releasePointer = (e?: Event): void => {
    if (!pointerHeld) return
    if (e && activePointerId !== (e as PointerEvent).pointerId) return
    pointerHeld = false
    activePointerId = null
    openSentinel()
  }

  const onPointerUp = (e: Event): void => {
    releasePointer(e)
  }

  const onPointerCancel = (e: Event): void => {
    releasePointer(e)
  }

  const onWindowBlur = (): void => {
    releasePointer()
  }

  const startOptionalObserving = (): void => {
    if (guardDisplayNone && !io && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(emit)
      io.observe(target)
    }
    if (followScroll && !scrollListening) {
      window.addEventListener('scroll', onScroll, passiveCapture)
      scrollListening = true
    }
    if (followGeometry && !geometryListening) {
      window.addEventListener('pointerdown', onPointerDown, capture)
      window.addEventListener('pointerup', onPointerUp, capture)
      window.addEventListener('pointercancel', onPointerCancel, capture)
      window.addEventListener('blur', onWindowBlur)
      geometryListening = true
    }
  }

  const stopOptionalObserving = (): void => {
    if (io && !guardDisplayNone) {
      io.disconnect()
      io = null
    }
    if (scrollListening && !followScroll) {
      window.removeEventListener('scroll', onScroll, passiveCapture)
      scrollListening = false
    }
    if (geometryListening && !followGeometry) {
      window.removeEventListener('pointerdown', onPointerDown, capture)
      window.removeEventListener('pointerup', onPointerUp, capture)
      window.removeEventListener('pointercancel', onPointerCancel, capture)
      window.removeEventListener('blur', onWindowBlur)
      geometryListening = false
      closeSentinel()
    }
  }

  const stopAllOptionalObserving = (): void => {
    if (io) {
      io.disconnect()
      io = null
    }
    if (scrollListening) {
      window.removeEventListener('scroll', onScroll, passiveCapture)
      scrollListening = false
    }
    if (geometryListening) {
      window.removeEventListener('pointerdown', onPointerDown, capture)
      window.removeEventListener('pointerup', onPointerUp, capture)
      window.removeEventListener('pointercancel', onPointerCancel, capture)
      window.removeEventListener('blur', onWindowBlur)
      geometryListening = false
    }
    closeSentinel()
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(emit)
    observer.observe(target)
    window.addEventListener('resize', emit)
    startOptionalObserving()
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    window.removeEventListener('resize', emit)
    stopAllOptionalObserving()
  }

  const apply = (): void => {
    lastPublished = null
    if (visible) {
      startObserving()
      const placement = computePlacement()
      if (placement) publishCandidate(placement)
    } else {
      stopObserving()
      const hidden: Placement = { visible: false }
      publishCandidate(hidden)
    }
  }

  apply()

  return {
    update(next: PlacementAnchorOptions): void {
      if (disposed) return
      publish = next.publish
      visible = next.visible
      // Omitting a flag preserves its current value so callers that only
      // pass { visible, publish } don't inadvertently disable enabled flags.
      guardDisplayNone = next.guardDisplayNone ?? guardDisplayNone
      followScroll = next.followScroll ?? followScroll
      followGeometry = next.followGeometry ?? followGeometry
      if (visible && observer) {
        stopOptionalObserving()
        startOptionalObserving()
      }
      apply()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopObserving()
    },
    pulse(durationMs?: number): void {
      if (disposed || !followGeometry) return
      if (durationMs !== undefined && durationMs > 0) {
        const next = performance.now() + durationMs
        sentinelDeadline = sentinelDeadline === null ? next : Math.max(sentinelDeadline, next)
      }
      openSentinel()
    },
  }
}
