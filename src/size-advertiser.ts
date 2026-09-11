import type {
  AdvertisedSize,
  Publisher,
  SizeAdvertiserOptions,
  SizeAdvertiserHandle,
} from './types.js'
import { createMeasureLoop } from './measure-loop.js'

/**
 * Report content size for a single axis back to the host.
 *
 * Runs in a downstream document, reads the content size from
 * `ResizeObserverEntry.borderBoxSize` without triggering reflow, and
 * publishes updates through an animation frame loop (`createMeasureLoop`).
 *
 * Measurements are rounded to integer pixels and clamped to >= 0.
 *
 * Note: `target` should be a shrink-to-fit wrapper on the owned axis.
 * If its size is driven by the host view itself (such as `<body>` or `<html>`),
 * updates will not shrink back to content size.
 */
export function createSizeAdvertiser(
  target: HTMLElement,
  opts: SizeAdvertiserOptions,
): SizeAdvertiserHandle {
  const axis = opts.axis
  let publish = opts.publish
  let observer: ResizeObserver | null = null
  let disposed = false
  // Latest border-box recorded by the ResizeObserver callback.
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
    sink: (extent) => publish({ axis, extent }),
  })

  const onResize: ResizeObserverCallback = (entries) => {
    const entry = entries[entries.length - 1]
    if (entry) {
      latest = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0] ?? latest
    }
    loop.schedule()
  }

  // Warn if measuring body or documentElement, whose size matches the view.
  const doc = target.ownerDocument
  if (target === doc.body || target === doc.documentElement) {
    console.warn(
      `[view-anchor] size-advertiser: <${target === doc.body ? 'body' : 'html'}>'s ` +
        `${axis} size is the view size, not content size. The advertiser will ` +
        `never shrink to content; measure a shrink-to-fit wrapper instead.`,
    )
  }

  loop.setActive(true)
  observer = new ResizeObserver(onResize)
  observer.observe(target)

  return {
    update(nextPublish: Publisher<AdvertisedSize>): void {
      if (disposed) return
      publish = nextPublish
      // Re-publish the current size to the new sink immediately so it is not
      // empty until the next ResizeObserver tick.
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
