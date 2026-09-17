import type { SizeAnchorOptions, SizeAnchorHandle } from './types.js'
import { watchAbort } from './abort.js'

// Replaces a disposed instance's publish callback so a retained handle does
// not keep the caller's original callback (and whatever it captured) alive.
const NOOP_PUBLISH = (): false => false

/**
 * Report content size for a single axis back to the host.
 *
 * Runs in a downstream document, reads the content size from
 * `ResizeObserverEntry.borderBoxSize` without triggering reflow, and
 * publishes at most once per animation frame, skipping unchanged extents by
 * default (see the `dedupe` option).
 *
 * Measurements are rounded to integer pixels and clamped to >= 0.
 *
 * `target` must be a shrink-to-fit wrapper on the owned axis.
 * If its size is driven by the host view itself (such as `<body>` or `<html>`),
 * updates will not shrink back to content size.
 */
export function createSizeAnchor(target: HTMLElement, opts: SizeAnchorOptions): SizeAnchorHandle {
  const axis = opts.axis
  let dedupe = opts.dedupe ?? true
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  let rafId: number | null = null
  let disposed = false
  // Latest border-box recorded by the ResizeObserver callback.
  let latestBoxSize: ResizeObserverSize | null = null
  // Last extent passed to publish; null until one is accepted.
  let lastPublished: number | null = null
  let publicationRevision = 0

  const measure = (): number | null => {
    if (!latestBoxSize) return null
    const raw = axis === 'block' ? latestBoxSize.blockSize : latestBoxSize.inlineSize
    if (!Number.isFinite(raw)) return null
    return Math.max(0, Math.round(raw))
  }

  const publishExtent = (extent: number): void => {
    const previous = lastPublished
    const attempt = ++publicationRevision
    lastPublished = extent
    try {
      const accepted = publish({ axis, extent }) !== false
      // A reentrant update() or dispose() during publish() already moved the
      // baseline; do not roll back over that newer state.
      if (!accepted && publicationRevision === attempt && !disposed) lastPublished = previous
    } catch (error) {
      if (publicationRevision === attempt && !disposed) lastPublished = previous
      throw error
    }
  }

  const publishFrame = (): void => {
    rafId = null
    if (disposed) return
    const extent = measure()
    if (extent === null) return
    if (dedupe && extent === lastPublished) return
    publishExtent(extent)
  }

  const onResize: ResizeObserverCallback = (entries) => {
    // A callback queued before disconnect() can still fire once more; do not
    // let it write `latestBoxSize` after dispose() has already cleared it.
    if (disposed) return
    const entry = entries[entries.length - 1]
    if (entry) {
      latestBoxSize = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0] ?? latestBoxSize
    }
    if (rafId === null) rafId = requestAnimationFrame(publishFrame)
  }

  // Warn if measuring body or documentElement, whose size matches the view.
  const doc = target.ownerDocument
  if (target === doc.body || target === doc.documentElement) {
    console.warn(
      `[view-anchor] size-anchor: <${target === doc.body ? 'body' : 'html'}>'s ` +
        `${axis} size is the view size, not content size. The size anchor will ` +
        `never shrink to content; measure a shrink-to-fit wrapper instead.`,
    )
  }

  let removeAbortListener = (): void => {}

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    removeAbortListener()
    removeAbortListener = (): void => {}
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (observer) {
      observer.disconnect()
      observer = null
    }
    publish = NOOP_PUBLISH
    latestBoxSize = null
    lastPublished = null
  }

  if (opts.signal?.aborted) dispose()
  else {
    removeAbortListener = watchAbort(opts.signal, dispose)
    observer = new ResizeObserver(onResize)
    observer.observe(target)
  }

  return {
    update(next: Omit<SizeAnchorOptions, 'signal' | 'axis'>): void {
      if (disposed) return
      publish = next.publish
      dedupe = next.dedupe ?? true
      // The new callback has not accepted anything yet, so an extent the old
      // callback rejected (or never saw) must not stay latched as the dedupe
      // baseline — otherwise a later identical tick would be silently
      // deduped against a value this callback was never actually given.
      lastPublished = null
      // Re-publish the current size to the new sink immediately so it is not
      // empty until the next ResizeObserver tick.
      const extent = measure()
      if (extent !== null) publishExtent(extent)
    },
    dispose,
  }
}
