/**
 * Internal helper: animation-frame scheduling and deduplication loop for
 * `createSizeAdvertiser`.
 *
 * Coalesces resize triggers into a single requestAnimationFrame, drops
 * duplicate measurements, and manages disposal.
 */

export interface MeasureLoop<T> {
  schedule(): void
  emitNow(value: T): void
  setActive(on: boolean): void
  cancel(): void
  dispose(): void
}

export function createMeasureLoop<T>(cfg: {
  /**
   * Produce the value to emit in the animation frame. Return null to skip
   * the frame (e.g. for non-finite measurements).
   */
  produce: () => T | null
  same: (a: T, b: T) => boolean
  sink: import('./types.js').Publisher<T>
}): MeasureLoop<T> {
  const { produce, same, sink } = cfg
  let rafId: number | null = null
  let active = false
  let disposed = false
  let last: T | null = null
  let publicationRevision = 0

  const deliver = (value: T): boolean => {
    const previous = last
    const attempt = ++publicationRevision
    last = value
    try {
      const accepted = sink(value) !== false
      if (!accepted && publicationRevision === attempt) last = previous
      return accepted
    } catch (error) {
      if (publicationRevision === attempt) last = previous
      throw error
    }
  }

  const cancel = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  const frame = (): void => {
    rafId = null
    if (disposed || !active) return
    const value = produce()
    if (value === null) return
    if (last !== null && same(value, last)) return
    deliver(value)
  }

  return {
    schedule(): void {
      if (disposed || !active || rafId !== null) return
      rafId = requestAnimationFrame(frame)
    },
    emitNow(value: T): void {
      if (disposed) return
      deliver(value)
    },
    setActive(on: boolean): void {
      active = on
    },
    cancel,
    dispose(): void {
      if (disposed) return
      disposed = true
      cancel()
    },
  }
}
