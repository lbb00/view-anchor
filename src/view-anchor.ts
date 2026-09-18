import type { Bounds, Placement, Publisher } from './types.js'
import { watchAbort } from './abort.js'

// Replaces a disposed instance's publish callback so a retained handle does
// not keep the caller's original callback (and whatever it captured) alive.
const NOOP_PUBLISH = (): false => false

// Default holdSelector: omitting the option keeps tracking presses on a role=separator splitter.
export const DEFAULT_HOLD_SELECTOR = '[role="separator"]'

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
   * When true, listens for capture-phase scroll events on window to re-measure
   * when an ancestor container scrolls. Default is false.
   * update() applies the same default: omitting it resets to false.
   */
  followScroll?: boolean
  /**
   * When true, polls geometry per animation frame during active motion (scrolls,
   * splitter dragging, or pulse()) and auto-closes when steady.
   * update() applies the same default: omitting it resets to false.
   */
  followGeometry?: boolean
  /**
   * CSS selector for the press-and-hold target that keeps followGeometry open
   * for the duration of a pointer press. Only meaningful when followGeometry
   * is true; the pointer listeners are mounted only while both are set. A capture-phase pointerdown whose
   * target matches `closest(holdSelector)` opens frame following until release.
   * Default is `[role="separator"]`. Pass null to disable. update() applies
   * the same default when omitted. An invalid selector throws synchronously
   * (SyntaxError) before any option is applied.
   */
  holdSelector?: string | null
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
   * holdSelector → `[role="separator"]` (pass null to disable), dedupe → true.
   * `signal` is not accepted here — it cannot be changed after creation.
   */
  update(opts: Omit<ViewAnchorOptions, 'signal'>): void
  /** Stop observing; never publish again. */
  dispose(): void
  /**
   * Open a frame-following window. Auto-closes once stable
   * or after durationMs. No-op if followGeometry is false.
   * durationMs is an upper bound, not a minimum: the window closes as soon as
   * two frames measure the same rect, so a transition that starts slowly
   * (sub-pixel movement in its first frames) may not be followed to the end.
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
 * Bind a native view or external surface to the geometry of `target`.
 *
 * When `visible === true`, publishes { visible: true, bounds } immediately,
 * then re-measures synchronously on ResizeObserver and window resize.
 * When `visible === false`, publishes { visible: false } and stops observing.
 * Publishes are deduplicated against the last accepted Placement by default
 * (see the `dedupe` option).
 */
export function createViewAnchor(target: HTMLElement, opts: ViewAnchorOptions): ViewAnchorHandle {
  // A non-empty holdSelector must be a syntactically valid CSS selector
  // (matches() throws SyntaxError otherwise). Validate before any state is
  // created so a bad selector never partially applies.
  if (opts.holdSelector) target.matches(opts.holdSelector)
  let visible = opts.visible
  let publish = opts.publish
  let treatZeroAreaAsHidden = opts.treatZeroAreaAsHidden ?? false
  let followScroll = opts.followScroll ?? false
  let followGeometry = opts.followGeometry ?? false
  let holdSelector = opts.holdSelector === undefined ? DEFAULT_HOLD_SELECTOR : opts.holdSelector
  let dedupe = opts.dedupe ?? true
  // Clearable alias so dispose() can drop the reference.
  let targetRef: HTMLElement | null = target
  let observer: ResizeObserver | null = null
  let intersectionObserver: IntersectionObserver | null = null
  let scrollListening = false
  let geometryListening = false
  const capture = { capture: true }
  const passiveCapture = { capture: true, passive: true }
  let lastPublished: Placement | null = null
  let publicationRevision = 0
  let disposed = false

  // --- Frame following (followGeometry) state ---
  // Frame following polls per frame during active movement and auto-closes once
  // geometry settles. While closed, no frame is scheduled (zero idle overhead).
  let rafId: number | null = null
  let steadyFrames = 0
  const STEADY_CLOSE_FRAMES = 2
  const MAX_HIDDEN_FOLLOW_FRAMES = 30
  const MAX_INVALID_FOLLOW_FRAMES = 30
  let hiddenFrames = 0
  let invalidFrames = 0
  // Pointer ids currently matching holdSelector and held down. Non-empty
  // keeps frame following open regardless of deadline or steady frames.
  const heldPointerIds = new Set<number>()
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
    if (
      disposed ||
      !visible ||
      (heldPointerIds.size === 0 && followDeadline !== null && performance.now() >= followDeadline)
    ) {
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
      if (++steadyFrames >= STEADY_CLOSE_FRAMES && heldPointerIds.size === 0) {
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
    heldPointerIds.clear()
  }

  const onScroll = (): void => {
    if (followGeometry) startFrameFollow()
    else measureAndPublish()
  }

  const onPointerDown = (e: Event): void => {
    const t = e.target as Element | null
    if (holdSelector && t && t.closest && t.closest(holdSelector)) {
      // The first of possibly several concurrently-held pointers drops any
      // pulse() deadline: a held press has no time limit.
      if (heldPointerIds.size === 0) followDeadline = null
      heldPointerIds.add((e as PointerEvent).pointerId)
      startFrameFollow()
    }
  }

  // pointerId undefined means "release everything" (window blur, or an event
  // that never carried a pointerId, matching the single-pointer tests that
  // dispatch plain Events). Otherwise only that one id's hold ends, and the
  // frame following only leaves its held (no-deadline) state once none remain.
  const releasePointer = (pointerId?: number): void => {
    if (heldPointerIds.size === 0) return
    if (pointerId !== undefined && !heldPointerIds.delete(pointerId)) return
    if (pointerId === undefined) heldPointerIds.clear()
    if (heldPointerIds.size > 0) return
    followDeadline = null
    startFrameFollow()
  }

  const onPointerUp = (e: Event): void => {
    releasePointer((e as PointerEvent).pointerId)
  }

  const onPointerCancel = (e: Event): void => {
    releasePointer((e as PointerEvent).pointerId)
  }

  const onWindowBlur = (): void => {
    releasePointer()
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
      window.addEventListener('scroll', onScroll, passiveCapture)
      scrollListening = true
    }
    // Mounted only while both followGeometry and holdSelector are set.
    if (followGeometry && holdSelector && !geometryListening) {
      window.addEventListener('pointerdown', onPointerDown, capture)
      window.addEventListener('pointerup', onPointerUp, capture)
      window.addEventListener('pointercancel', onPointerCancel, capture)
      window.addEventListener('blur', onWindowBlur)
      geometryListening = true
    }
  }

  const stopIntersection = (): void => {
    if (!intersectionObserver) return
    intersectionObserver.disconnect()
    intersectionObserver = null
  }

  const stopScroll = (): void => {
    if (!scrollListening) return
    window.removeEventListener('scroll', onScroll, passiveCapture)
    scrollListening = false
  }

  const stopGeometryListeners = (): void => {
    if (!geometryListening) return
    window.removeEventListener('pointerdown', onPointerDown, capture)
    window.removeEventListener('pointerup', onPointerUp, capture)
    window.removeEventListener('pointercancel', onPointerCancel, capture)
    window.removeEventListener('blur', onWindowBlur)
    geometryListening = false
  }

  // Detaches only the optional observers whose flag has been turned off.
  const stopDisabledObserving = (): void => {
    if (!treatZeroAreaAsHidden) stopIntersection()
    if (!followScroll) stopScroll()
    // The pointer listeners are only useful while both flags hold; drop them
    // (and any held-pointer state they were tracking) as soon as either lapses.
    if ((!followGeometry || !holdSelector) && geometryListening) {
      stopGeometryListeners()
      heldPointerIds.clear()
    }
    // Independent of whether the listeners were mounted: turning followGeometry
    // off must always stop frame following, not just when holdSelector was set.
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
    stopGeometryListeners()
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
      // Validate before touching any state so a bad selector throws
      // atomically and the previous holdSelector stays in effect.
      if (next.holdSelector) targetRef!.matches(next.holdSelector)
      publish = next.publish
      visible = next.visible
      // Full configuration: omitted flags reset to defaults.
      treatZeroAreaAsHidden = next.treatZeroAreaAsHidden ?? false
      followScroll = next.followScroll ?? false
      followGeometry = next.followGeometry ?? false
      holdSelector = next.holdSelector === undefined ? DEFAULT_HOLD_SELECTOR : next.holdSelector
      dedupe = next.dedupe ?? true
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
