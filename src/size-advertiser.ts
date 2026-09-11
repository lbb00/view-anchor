import type {
  AdvertisedSize,
  Publisher,
  SizeAdvertiserOptions,
  SizeAdvertiserHandle,
} from './types.js'
import { createMeasureLoop } from './measure-loop.js'

/**
 * Reverse of `createViewAnchor`: runs in a downstream WebContentsView's own
 * renderer, measures the content's own size on ONE owned axis (from the
 * `ResizeObserver` border-box — no `getBoundingClientRect`, no forced reflow),
 * and advertises it via the injected `publish`. Its reverse-only
 * measure/coalesce/dedupe/dispose engine is `createMeasureLoop`.
 *
 * The extent is `Math.round`ed and clamped to `>= 0`; non-finite measurements
 * drop the frame.
 *
 * FOOTGUN — `target` must be shrink-to-fit on the owned axis: its owned-axis
 * size must NOT be driven by the host-applied view size, or the cross-process
 * loop (advertise → host resizes view → remeasure) never converges (it
 * oscillates or stays "stable but wrong"). Measuring `<body>`/`<html>` is the
 * classic mistake — their size *is* the view size. See
 * `docs/bidirectional-design.md`'s single-axis-ownership and trust-boundary
 * sections.
 */
export function createSizeAdvertiser(
  target: HTMLElement,
  opts: SizeAdvertiserOptions,
): SizeAdvertiserHandle {
  const axis = opts.axis // immutable for the advertiser's life
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  let disposed = false
  // Latest border-box, stashed by the RO callback and read by `produce` in the
  // RAF body (keep the entry out of the shared, DOM-agnostic loop).
  let latest: ResizeObserverSize | null = null

  const produce = (): number | null => {
    if (!latest) return null
    const raw = axis === 'block' ? latest.blockSize : latest.inlineSize
    if (!Number.isFinite(raw)) return null
    return Math.max(0, Math.round(raw))
  }

  const loop = createMeasureLoop<number>({
    produce,
    same: (a, b) => a === b,
    // Keep the loop's dedupe value scalar. The public object only needs to
    // exist when the publisher is actually invoked for an advertised frame.
    sink: (extent) => publish({ axis, extent }),
  })

  const onResize: ResizeObserverCallback = (entries) => {
    const entry = entries[entries.length - 1]
    if (entry) {
      latest = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0] ?? latest
    }
    loop.schedule()
  }

  // One cheap, once-per-advertiser guard for the textbook feedback-loop footgun.
  const doc = target.ownerDocument
  if (target === doc.body || target === doc.documentElement) {
    console.warn(
      `[view-anchor] size-advertiser: <${target === doc.body ? 'body' : 'html'}>'s ` +
        `${axis} size is the host-given view size, not the content size — the ` +
        `advertiser will never shrink to content. Measure a shrink-to-fit wrapper. ` +
        `See bidirectional-design.md's single-axis-ownership section.`,
    )
  }

  loop.setActive(true)
  observer = new ResizeObserver(onResize)
  observer.observe(target)

  return {
    update(nextPublish: Publisher<AdvertisedSize>): void {
      if (disposed) return
      publish = nextPublish
      // Re-advertise the current size to the new sink immediately (mirrors the
      // forward anchor's re-publish on update) so the new channel is not left
      // sizeless until the next ResizeObserver tick.
      const cur = produce()
      if (cur !== null) loop.emitNow(cur)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      loop.cancel()
      if (observer) {
        observer.disconnect()
        observer = null
      }
      loop.dispose()
    },
  }
}
