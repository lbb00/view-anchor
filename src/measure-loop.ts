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

// Terminal-state stand-ins for cfg.produce/same/sink so a retained handle's
// dispose()d loop does not keep the original closures (or what they
// captured) alive. Guarded call sites never actually reach these.
const NOOP_PRODUCE = (): null => null
const NOOP_SAME = (): true => true
const NOOP_SINK = (): false => false

export function createMeasureLoop<T>(cfg: {
  /**
   * Produce the value to emit in the animation frame. Return null to skip
   * the frame (e.g. for non-finite measurements).
   */
  produce: () => T | null
  same: (a: T, b: T) => boolean
  sink: import('./types.js').Publisher<T>
}): MeasureLoop<T> {
  let produce = cfg.produce
  let same = cfg.same
  let sink = cfg.sink
  let rafId: number | null = null
  let active = false
  let disposed = false
  let last: T | null = null
  let publicationRevision = 0

  const deliver = (value: T): boolean => {
    // A reentrant dispose() from produce()/same() (invoked by frame() just
    // before this call) already cleared `last`; do not let this delivery
    // attempt write over that terminal state.
    if (disposed) return false
    const previous = last
    const attempt = ++publicationRevision
    last = value
    try {
      const accepted = sink(value) !== false
      // A reentrant dispose() during sink() already cleared `last`; do not
      // resurrect the pre-dispose value over that terminal state.
      if (!accepted && publicationRevision === attempt && !disposed) last = previous
      return accepted
    } catch (error) {
      if (publicationRevision === attempt && !disposed) last = previous
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
      produce = NOOP_PRODUCE
      same = NOOP_SAME
      sink = NOOP_SINK
      last = null
    },
  }
}
