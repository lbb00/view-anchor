import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createSizeAnchor } from '../src/size-anchor.js'
import type { SizeMeasurement } from '../src/types.js'

// ── Reverse-direction stubs ──────────────────────────────────────────
//
// The size anchor reads `entry.borderBoxSize`, not `getBoundingClientRect()`.
// `fire(blockSize, inlineSize)` builds a standards-shaped RO entry: an array
// with `borderBoxSize: [{ blockSize, inlineSize }]` (and a matching
// contentBoxSize). There is no `present` flag and no terminal detach value.
//
// `fakeRaf`/`flushRafs` queue RAF callbacks so tests control when they run.
// `cancelAnimationFrame` also evicts the queued entry, so a cancelled RAF
// can never fire (lets us assert the dispose stale-RAF guard).

interface RoSize {
  blockSize: number
  inlineSize: number
}
interface RoEntry {
  borderBoxSize: RoSize[]
  contentBoxSize: RoSize[]
  target: Element
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  unobserve(): void {
    /* unused */
  }
  disconnect(): void {
    this.disconnected = true
  }
  /** Fire the RO callback with one standards-shaped entry for the observed
   *  target, carrying the given border-box block/inline extents. */
  fire(blockSize: number, inlineSize: number): void {
    const target = this.observed[0] ?? document.createElement('div')
    const entry: RoEntry = {
      borderBoxSize: [{ blockSize, inlineSize }],
      contentBoxSize: [{ blockSize, inlineSize }],
      target,
    }
    this.cb([entry] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}

interface RafEntry {
  id: number
  cb: () => void
}
let rafQueue: RafEntry[] = []
let rafIdCounter = 0
function fakeRaf(cb: () => void): number {
  rafIdCounter++
  rafQueue.push({ id: rafIdCounter, cb })
  return rafIdCounter
}
const cancelSpy = vi.fn()

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafQueue = []
  rafIdCounter = 0
  cancelSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', fakeRaf as unknown as typeof window.requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) => {
    cancelSpy(id)
    // A cancelled RAF must never fire — evict it so flushRafs() can't run a
    // callback the size anchor cancelled.
    rafQueue = rafQueue.filter((e) => e.id !== id)
  }) as unknown as typeof window.cancelAnimationFrame)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushRafs(): void {
  const q = rafQueue
  rafQueue = []
  q.forEach((e) => e.cb())
}

/** Assert an observer was installed, then return it — a missing observer
 *  surfaces as a clear assertion failure instead of a TypeError on `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

/** A bare element. If the size anchor were reading from getBoundingClientRect
 *  instead of the RO entry, the spy would catch it. */
function buildElement(): { el: HTMLElement; rectSpy: ReturnType<typeof vi.fn> } {
  const el = document.createElement('div')
  const rectSpy = vi.fn(() => {
    throw new Error('getBoundingClientRect must not be called by the size anchor')
  })
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(rectSpy as unknown as () => DOMRect)
  return { el, rectSpy }
}

describe('createSizeAnchor: border-box measurement', () => {
  it('reads borderBoxSize from the entry and never calls getBoundingClientRect', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el, rectSpy } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    // block axis must come from blockSize (200), not inlineSize (999).
    firstObserver().fire(200, 999)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 200 })
    expect(rectSpy).not.toHaveBeenCalled()
  })

  it('axis:inline reads inlineSize from the border-box entry', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'inline', publish })
    publish.mockClear()

    // inline axis must come from inlineSize (321), not blockSize (10).
    firstObserver().fire(10, 321)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'inline', extent: 321 })
  })
})

describe('createSizeAnchor: single-axis payload', () => {
  it('publishes only { axis, extent } with axis equal to the owned axis', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(150, 280)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    const payload = publish.mock.calls[0]![0]
    expect(payload.axis).toBe('block')
    expect(payload.extent).toBe(150)
    // No second-axis field smuggled in.
    expect(Object.keys(payload).sort()).toEqual(['axis', 'extent'])
  })
})

describe('createSizeAnchor: quantize and clamp', () => {
  it('rounds the raw extent (Math.round)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(100.49, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
  })

  it('clamps a negative extent to 0 and STILL publishes that frame (not dropped)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(-7.2, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 0 })
  })
})

describe('createSizeAnchor: non-finite values', () => {
  it('does not publish when the raw extent is NaN', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(NaN, 100)
    flushRafs()

    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish when the raw extent is Infinity', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(Infinity, 100)
    flushRafs()

    expect(publish).not.toHaveBeenCalled()
  })
})

describe('createSizeAnchor: RAF coalescing', () => {
  it('multiple RO ticks in one frame schedule one RAF and publish once', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    const ro = firstObserver()
    // Distinct extents per tick — only the last, coalesced value should emit.
    ro.fire(100, 0)
    ro.fire(150, 0)
    ro.fire(200, 0)

    // Nothing synchronous; exactly one RAF queued for the whole burst.
    expect(publish).not.toHaveBeenCalled()
    expect(rafQueue).toHaveLength(1)

    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 200 })
  })

  it('reuses one RAF callback function across separate scheduled frames', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    const ro = firstObserver()

    ro.fire(100, 0)
    const firstCallback = rafQueue[0]!.cb
    flushRafs()
    ro.fire(200, 0)

    expect(rafQueue[0]!.cb).toBe(firstCallback)
  })
})

describe('createSizeAnchor: last-extent deduplication', () => {
  it('an unchanged extent on a follow-up RO tick does not re-publish', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)

    // Same extent again → silent.
    firstObserver().fire(120, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes again once the extent changes', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    firstObserver().fire(140, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ axis: 'block', extent: 140 })
  })

  it('dedupe is post-quantization: 120.4 then 120 (both round to 120) emits once', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120.4, 0)
    flushRafs()
    firstObserver().fire(120, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
  })
})

describe('createSizeAnchor: dedupe option', () => {
  it('defaults to true: an unchanged extent on a follow-up tick stays silent', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    firstObserver().fire(120, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('dedupe: false publishes on every measurement, even an unchanged extent', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish, dedupe: false })
    publish.mockClear()

    firstObserver().fire(120, 0)
    flushRafs()
    firstObserver().fire(120, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({ axis: 'block', extent: 120 })
  })

  it('update() applies the same default as creation: omitting dedupe resets it to true', () => {
    const first = vi.fn<(s: SizeMeasurement) => void>()
    const second = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish: first, dedupe: false })
    firstObserver().fire(120, 0)
    flushRafs()
    first.mockClear()

    // update() replaces the previous configuration outright: omitting
    // dedupe resets it to the default (true).
    handle.update({ publish: second })
    second.mockClear()
    firstObserver().fire(120, 0)
    flushRafs()
    expect(second).not.toHaveBeenCalled()

    // Passing dedupe: false again re-enables per-tick publishing.
    handle.update({ publish: second, dedupe: false })
    second.mockClear()
    firstObserver().fire(120, 0)
    flushRafs()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith({ axis: 'block', extent: 120 })
  })
})

describe('createSizeAnchor: handle methods', () => {
  it('exposes only update and dispose (no present)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish })

    expect(typeof handle.update).toBe('function')
    expect(typeof handle.dispose).toBe('function')
    expect('present' in (handle as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('createSizeAnchor: update()', () => {
  it('routes subsequent emits to the new publish', () => {
    const first = vi.fn<(s: SizeMeasurement) => void>()
    const second = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish: first })
    first.mockClear()

    handle.update({ publish: second })

    firstObserver().fire(170, 0)
    flushRafs()
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 170 })
    expect(first).not.toHaveBeenCalled()
  })

  it('clears the dedupe baseline so a same-extent tick is retried after switching away from a callback that had accepted it', () => {
    const first = vi.fn<(s: SizeMeasurement) => boolean | void>(() => undefined)
    const second = vi.fn<(s: SizeMeasurement) => boolean>(() => false)
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish: first })

    firstObserver().fire(100, 0)
    flushRafs()
    expect(first).toHaveBeenCalledWith({ axis: 'block', extent: 100 })

    handle.update({ publish: second })
    expect(second).toHaveBeenCalledTimes(1)
    second.mockClear()

    // Same extent as before: must still reach `second` (which never accepted
    // anything), not be silently deduped against the old callback's baseline.
    firstObserver().fire(100, 0)
    flushRafs()
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
  })

  it('clears the dedupe baseline even when update() is called synchronously from within a rejecting publish', () => {
    const { el } = buildElement()
    const inner = vi.fn<(s: SizeMeasurement) => boolean>(() => false)
    const outer = vi.fn<(s: SizeMeasurement) => boolean>(() => {
      handle.update({ publish: inner })
      return false
    })
    const handle = createSizeAnchor(el, { axis: 'block', publish: outer })

    firstObserver().fire(100, 0)
    flushRafs()
    expect(outer).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(1)
    inner.mockClear()

    // Both the outer and the reentrant inner callback rejected 100; a
    // follow-up tick with the same extent must still be offered to `inner`.
    firstObserver().fire(100, 0)
    flushRafs()
    expect(inner).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
  })
})

describe('createSizeAnchor: dispose()', () => {
  it('disconnects the observer and cancels a pending RAF', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish })

    // Queue a RAF so dispose has something to cancel.
    firstObserver().fire(160, 0)
    expect(rafQueue).toHaveLength(1)

    handle.dispose()

    expect(firstObserver().disconnected).toBe(true)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('never publishes again after dispose (later RO ticks are inert)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish })
    const ro = firstObserver()
    handle.dispose()
    publish.mockClear()

    ro.fire(220, 0)
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })

  it('a RAF queued before dispose() does not publish even if flushed', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish })

    firstObserver().fire(240, 0)
    expect(rafQueue).toHaveLength(1)
    publish.mockClear()

    handle.dispose()
    flushRafs() // queue empty after cancel, OR the cb bails on the guard

    expect(publish).not.toHaveBeenCalled()
  })
})

describe('createSizeAnchor: initial value', () => {
  it('publishes the first measurable size once on the first RO frame', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    createSizeAnchor(el, { axis: 'block', publish })

    // The first frame the observer delivers carries the initial size.
    firstObserver().fire(300, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 300 })
  })
})

describe('createSizeAnchor: update() applies dedupe like creation', () => {
  it('update() sets dedupe: false, then omitting it resets to the default (true)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const { el } = buildElement()
    const handle = createSizeAnchor(el, { axis: 'block', publish })

    firstObserver().fire(100, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)

    // dedupe: false → an unchanged extent still publishes on the next tick.
    handle.update({ publish, dedupe: false })
    publish.mockClear()
    firstObserver().fire(100, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ axis: 'block', extent: 100 })

    // Omitting dedupe on the next update() resets it to true: the same
    // extent is deduped again.
    handle.update({ publish })
    publish.mockClear()
    firstObserver().fire(100, 0)
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── SizeAnchorHandle.update() does not accept `signal` or `axis` ───────
//
// `signal` is read once at creation; `axis` is fixed for the anchor's lifetime.
// update()'s type is `Omit<SizeAnchorOptions, 'signal' | 'axis'>` so neither
// can be re-specified through update().
type SizeAnchorUpdateOptions = Parameters<ReturnType<typeof createSizeAnchor>['update']>[0]
const _updateRejectsSignal: SizeAnchorUpdateOptions = {
  publish: () => {},
  // @ts-expect-error update()'s options type does not include `signal`
  signal: new AbortController().signal,
}
void _updateRejectsSignal
// @ts-expect-error update()'s options type does not include `axis`
const _updateRejectsAxis: SizeAnchorUpdateOptions = { publish: () => {}, axis: 'block' }
void _updateRejectsAxis
