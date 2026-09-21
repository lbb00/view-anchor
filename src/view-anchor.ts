import type { Bounds, Placement, Publisher } from './types.js'
import { watchAbort } from './abort.js'

// Replaces a disposed instance's publish callback so a retained handle does
// not keep the caller's original callback (and whatever it captured) alive.
const NOOP_PUBLISH = (): false => false

// Round to integer pixels. Width and height are clamped to >= 0; x and y can be
// negative, so a view scrolled out of sight is not pinned to the screen edge.
const clampRect = (r: { x: number; y: number; width: number; height: number }): Bounds => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.max(0, Math.round(r.width)),
  height: Math.max(0, Math.round(r.height)),
})

export interface ViewAnchorOptions {
  /**
   * Whether the native view should be visible. When true, publishes
   * { visible: true, bounds }; when false, publishes { visible: false } and
   * stops observing, so a rejected hidden placement is only sent again by the
   * next update().
   */
  visible: boolean
  /** Receives each explicit Placement. */
  publish: Publisher<Placement>
  /**
   * Stops this anchor when aborted. An already-aborted signal starts no work.
   * Read once at creation only — update()'s type does not accept this field.
   */
  signal?: AbortSignal
  /**
   * When true, targets with zero area (such as display: none or unmounted elements)
   * publish { visible: false } instead of { visible: true, bounds: 0x0 }, and an
   * IntersectionObserver tracks display: none transitions. Default is false.
   * update() applies the same default: omitting it resets to false.
   */
  treatZeroAreaAsHidden?: boolean
  /**
   * When true, re-measures on scroll events. Uses a hybrid approach:
   * - A capture-phase window scroll listener provides a reliable fallback that
   *   catches all scrolls (including overflow:hidden + programmatic scrollLeft/Top,
   *   and works even before the element is connected or after reparenting).
   * - Scrollable ancestor listeners catch scrolls in detached subtrees or shadow
   *   roots that do not reach window. Events reaching window are handled there
   *   only once, even when dedupe is disabled.
   * Ancestors are re-collected on update().
   * Default is false. update() applies the same default: omitting it resets to false.
   */
  followScroll?: boolean
  /**
   * When true, polls geometry per animation frame during active motion (scrolls
   * or pulse()) and auto-closes when steady.
   * update() applies the same default: omitting it resets to false.
   */
  followGeometry?: boolean
  /**
   * When true (the default), a measurement identical to the last accepted
   * Placement is not published again. When false, every usable frame publishes
   * even if the Placement is unchanged; the steady-frame close and the
   * invalid/hidden frame caps still compare values either way. Hidden frames
   * are never published by frame following regardless of this option. Omitting
   * it in update() resets to true.
   */
  dedupe?: boolean
}

export interface ViewAnchorHandle {
  /**
   * Apply a full set of options and re-publish immediately. Omitted options
   * reset to defaults: treatZeroAreaAsHidden/followScroll/followGeometry → false,
   * dedupe → true.
   * `signal` is not accepted here — it cannot be changed after creation.
   */
  update(opts: Omit<ViewAnchorOptions, 'signal'>): void
  /** Stop observing; never publish again. */
  dispose(): void
  /**
   * Open a frame-following window. Auto-closes once stable
   * or after durationMs. No-op if followGeometry is false.
   * durationMs is an upper bound, not a minimum: the window closes as soon as
   * two consecutive frames measure the same rect, so a transition that starts
   * slowly (sub-pixel movement in its first frames) may not be followed to the end.
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
 * Determine if an element is scrollable on either axis.
 */
const isScrollable = (el: Element): boolean => {
  const style = getComputedStyle(el)
  const overflowY = style.overflowY
  const overflowX = style.overflowX
  return (
    overflowY === 'auto' ||
    overflowY === 'scroll' ||
    overflowY === 'hidden' ||
    overflowX === 'auto' ||
    overflowX === 'scroll' ||
    overflowX === 'hidden'
  )
}

/**
 * Collect all scrollable ancestors of an element, from parent to root.
 * Returns an array where the first element is the closest scrollable ancestor.
 */
const parentOrShadowHost = (el: Element): Element | null => {
  if (el.parentElement) return el.parentElement
  const parent = el.parentNode
  return parent instanceof ShadowRoot ? parent.host : null
}

const collectScrollableAncestors = (el: HTMLElement): Element[] => {
  const ancestors: Element[] = []
  let current = parentOrShadowHost(el)
  while (current) {
    if (isScrollable(current)) {
      ancestors.push(current)
    }
    current = parentOrShadowHost(current)
  }
  return ancestors
}

// Internal steady-frame count for followGeometry auto-close
const STEADY_FRAME_COUNT = 2

/**
 * Bind a native view or external surface to the geometry of `target`.
 *
 * When `visible === true`, publishes { visible: true, bounds } immediately,
 * then re-measures synchronously on ResizeObserver and window resize.
 * When `visible === false`, publishes { visible: false } and stops observing.
 * Publishes are deduplicated against the last accepted Placement by default
 * (see the `dedupe` option).
 */
export function createViewAnchor(target: HTMLElement, opts: ViewAnchorOptions): ViewAnchorHandle {
  let visible = opts.visible
  let publish = opts.publish
  let treatZeroAreaAsHidden = opts.treatZeroAreaAsHidden ?? false
  let followScroll = opts.followScroll ?? false
  let followGeometry = opts.followGeometry ?? false
  let dedupe = opts.dedupe ?? true
  // Clearable alias so dispose() can drop the reference.
  let targetRef: HTMLElement | null = target
  let observer: ResizeObserver | null = null
  let intersectionObserver: IntersectionObserver | null = null
  let scrollListening = false
  // Scrollable ancestors we're currently listening to
  let scrollAncestors: Element[] = []
  const capture = { capture: true }
  const passiveOptions = { passive: true }
  let lastPublished: Placement | null = null
  let publicationRevision = 0
  let disposed = false

  // --- Frame following (followGeometry) state ---
  // Frame following polls per frame during active movement and auto-closes once
  // geometry settles. While closed, no frame is scheduled (zero idle overhead).
  let rafId: number | null = null
  let steadyFrames = 0
  const MAX_HIDDEN_FOLLOW_FRAMES = 30
  const MAX_INVALID_FOLLOW_FRAMES = 30
  let hiddenFrames = 0
  let invalidFrames = 0
  // The rect measured on the previous followed frame, independent of whether
  // publish() accepted it. Drives the steady/moving decision so a publish()
  // that keeps rejecting an unchanged measurement cannot keep resetting it.
  let lastFramePlacement: Placement | null = null
  let followDeadline: number | null = null

  const measureTarget = (): Placement | null => {
    const p = measurePlacement(targetRef!)
    if (
      p.visible &&
      (!Number.isFinite(p.bounds.x) ||
        !Number.isFinite(p.bounds.y) ||
        !Number.isFinite(p.bounds.width) ||
        !Number.isFinite(p.bounds.height))
    )
      return null
    if (treatZeroAreaAsHidden && p.visible && (p.bounds.width === 0 || p.bounds.height === 0)) {
      return { visible: false }
    }
    return p
  }

  const publishPlacement = (candidate: Placement): boolean => {
    const previous = lastPublished
    const attempt = ++publicationRevision
    lastPublished = candidate
    try {
      const accepted = publish(candidate) !== false
      // A reentrant dispose() during publish() already cleared lastPublished;
      // do not resurrect the pre-dispose value over that terminal state.
      if (!accepted && publicationRevision === attempt && !disposed) lastPublished = previous
      return accepted
    } catch (error) {
      if (publicationRevision === attempt && !disposed) lastPublished = previous
      throw error
    }
  }

  const measureAndPublish = (): void => {
    if (disposed || !visible) return
    const p = measureTarget()
    if (!p) return
    if (dedupe && lastPublished && samePlacement(lastPublished, p)) return
    publishPlacement(p)
  }

  // Polls again next frame if following is still wanted after this frame's work.
  const scheduleFollowFrame = (): void => {
    if (!disposed && visible && followGeometry) rafId = requestAnimationFrame(followFrame)
    else followDeadline = null
  }

  const followFrame = (): void => {
    rafId = null
    if (disposed || !visible || (followDeadline !== null && performance.now() >= followDeadline)) {
      followDeadline = null
      return
    }
    const p = measureTarget()
    if (!p) {
      if (++invalidFrames >= MAX_INVALID_FOLLOW_FRAMES) followDeadline = null
      else scheduleFollowFrame()
      return
    }
    invalidFrames = 0
    if (!p.visible) {
      // Hidden frames are never published here; stop once hidden is already
      // published or the target stays hidden past its budget.
      if (lastPublished?.visible === false || ++hiddenFrames >= MAX_HIDDEN_FOLLOW_FRAMES) {
        followDeadline = null
      } else {
        scheduleFollowFrame()
      }
      return
    }
    // Steadiness is judged against what was measured last frame, not against
    // what publish() accepted: a candidate that publish() keeps rejecting
    // must not keep looking "different" forever just because publishPlacement
    // rolls lastPublished back on rejection, which would spin the frame loop.
    const steadyFrame = lastFramePlacement !== null && samePlacement(lastFramePlacement, p)
    lastFramePlacement = p
    if (!dedupe || !lastPublished || !samePlacement(lastPublished, p)) publishPlacement(p)
    if (steadyFrame) {
      if (++steadyFrames >= STEADY_FRAME_COUNT) {
        followDeadline = null
        return
      }
    } else {
      steadyFrames = 0
      hiddenFrames = 0
    }
    scheduleFollowFrame()
  }

  const startFrameFollow = (): void => {
    if (!followGeometry || disposed) return
    steadyFrames = 0
    hiddenFrames = 0
    // Seed from the last accepted placement so the first post-open frame
    // doesn't look unsteady on an unchanged rect.
    lastFramePlacement = lastPublished
    if (rafId === null) {
      invalidFrames = 0
      rafId = requestAnimationFrame(followFrame)
    }
  }

  const stopFrameFollow = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    steadyFrames = 0
    hiddenFrames = 0
    invalidFrames = 0
    lastFramePlacement = lastPublished
    followDeadline = null
  }

  const onScroll = (): void => {
    if (followGeometry) startFrameFollow()
    else measureAndPublish()
  }

  const onAncestorScroll = (event: Event): void => {
    // Window's capture listener already handled events that reached it. Keep
    // ancestor listeners for events inside detached subtrees or shadow roots.
    if (!event.composedPath().includes(window.document)) onScroll()
  }

  // Passive + capture options for the window scroll listener fallback
  const passiveCapture = { passive: true, capture: true }

  const startScrollListening = (): void => {
    if (scrollListening || !targetRef) return
    // Hybrid scroll listening:
    // 1. Window capture-phase listener as a reliable fallback — catches all scrolls
    //    including overflow:hidden + programmatic scrollLeft/Top, works before
    //    element is connected or after reparenting without update().
    window.addEventListener('scroll', onScroll, passiveCapture)
    // 2. Scrollable ancestors handle events that do not reach window.
    scrollAncestors = collectScrollableAncestors(targetRef)
    for (const ancestor of scrollAncestors) {
      ancestor.addEventListener('scroll', onAncestorScroll, passiveOptions)
    }
    scrollListening = true
  }

  const stopScrollListening = (): void => {
    if (!scrollListening) return
    // Remove window capture listener
    window.removeEventListener('scroll', onScroll, capture)
    // Remove listeners from all ancestors and clear the array to avoid leaking
    // references to elements that may leave the DOM while this anchor lives.
    for (const ancestor of scrollAncestors) {
      ancestor.removeEventListener('scroll', onAncestorScroll)
    }
    scrollAncestors.length = 0
    scrollListening = false
  }

  const startOptionalObserving = (): void => {
    if (
      treatZeroAreaAsHidden &&
      !intersectionObserver &&
      typeof IntersectionObserver !== 'undefined'
    ) {
      intersectionObserver = new IntersectionObserver(measureAndPublish)
      intersectionObserver.observe(targetRef!)
    }
    if (followScroll && !scrollListening) {
      startScrollListening()
    }
  }

  const stopIntersection = (): void => {
    if (!intersectionObserver) return
    intersectionObserver.disconnect()
    intersectionObserver = null
  }

  const stopScroll = (): void => {
    stopScrollListening()
  }

  // Detaches only the optional observers whose flag has been turned off.
  const stopDisabledObserving = (): void => {
    if (!treatZeroAreaAsHidden) stopIntersection()
    if (!followScroll) stopScroll()
    if (!followGeometry) stopFrameFollow()
  }

  const startObserving = (): void => {
    if (observer) return
    observer = new ResizeObserver(measureAndPublish)
    observer.observe(targetRef!)
    window.addEventListener('resize', measureAndPublish)
    startOptionalObserving()
  }

  const stopObserving = (): void => {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    window.removeEventListener('resize', measureAndPublish)
    stopIntersection()
    stopScroll()
    stopFrameFollow()
  }

  const applyOptions = (): void => {
    lastPublished = null
    if (visible) {
      startObserving()
      const placement = measureTarget()
      if (placement) publishPlacement(placement)
    } else {
      stopObserving()
      const hidden: Placement = { visible: false }
      publishPlacement(hidden)
    }
  }

  let removeAbortListener = (): void => {}

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    removeAbortListener()
    removeAbortListener = (): void => {}
    stopObserving()
    targetRef = null
    publish = NOOP_PUBLISH
    lastPublished = null
  }

  if (opts.signal?.aborted) dispose()
  else {
    removeAbortListener = watchAbort(opts.signal, dispose)
    // A throwing first publish must not leave the observer/listeners it just
    // started (startObserving() runs before the first publishPlacement())
    // mounted on a handle the caller never got to dispose.
    try {
      applyOptions()
    } catch (error) {
      dispose()
      throw error
    }
  }

  return {
    update(next: Omit<ViewAnchorOptions, 'signal'>): void {
      if (disposed) return
      publish = next.publish
      visible = next.visible
      // Full configuration: omitted flags reset to defaults.
      treatZeroAreaAsHidden = next.treatZeroAreaAsHidden ?? false
      const newFollowScroll = next.followScroll ?? false
      followGeometry = next.followGeometry ?? false
      dedupe = next.dedupe ?? true
      // Recollect ancestors if followScroll is (still) on - target may have moved
      if (newFollowScroll && scrollListening) {
        stopScrollListening()
      }
      followScroll = newFollowScroll
      if (visible && observer) {
        stopDisabledObserving()
        startOptionalObserving()
      }
      applyOptions()
    },
    dispose,
    pulse(durationMs?: number): void {
      if (disposed || !followGeometry) return
      if (durationMs !== undefined && durationMs > 0) {
        const next = performance.now() + durationMs
        followDeadline = followDeadline === null ? next : Math.max(followDeadline, next)
      }
      startFrameFollow()
    },
  }
}
