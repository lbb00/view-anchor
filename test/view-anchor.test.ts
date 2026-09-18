import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { ViewAnchorOptions } from '../src/view-anchor.js'
import type { Bounds, Placement } from '../src/types.js'

// ── ResizeObserver / RAF stubs ───────────────────────────────────────
//
//   - `FakeResizeObserver` records observed elements + disconnect, and
//     exposes `fire()` to synchronously invoke its callback.
//   - The anchor publishes synchronously (no RAF defer). `requestAnimationFrame`
//     and `cancelAnimationFrame` are spy-only guards: the anchor must never
//     call either (asserted in the "never schedules a RAF" test).

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
  fire(): void {
    this.cb([], this)
  }
}

// RAF regression guards: if the anchor ever re-introduces a RAF defer these
// spies record a call, and the "never schedules a RAF" test fails.
const rafSpy = vi.fn(() => 0)
const cancelSpy = vi.fn()
const resizeAddSpy = vi.fn()
const resizeRemoveSpy = vi.fn()
// Handlers added via the addEventListener spy, tracked so afterEach can
// remove leaked 'resize' listeners from undisposed anchors.
let leakedResize: unknown[] = []

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafSpy.mockClear()
  cancelSpy.mockClear()
  resizeAddSpy.mockClear()
  resizeRemoveSpy.mockClear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', rafSpy as unknown as typeof window.requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelSpy as unknown as typeof window.cancelAnimationFrame)

  // Spy on window resize listener add/remove to assert the anchor installs
  // exactly one resize listener when visible and removes it on dispose or
  // visible=false. Forwards to the real implementation so dispatching a real
  // 'resize' event still works.
  const realAdd = window.addEventListener.bind(window)
  const realRemove = window.removeEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, ...rest: unknown[]) => {
    if (type === 'resize') {
      resizeAddSpy(...rest)
      leakedResize.push(rest[0])
    }
    return (realAdd as unknown as (...a: unknown[]) => void)(type, ...rest)
  })
  vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, ...rest: unknown[]) => {
    if (type === 'resize') {
      resizeRemoveSpy(...rest)
      leakedResize = leakedResize.filter((h) => h !== rest[0])
    }
    return (realRemove as unknown as (...a: unknown[]) => void)(type, ...rest)
  })
})

afterEach(() => {
  // Remove resize listeners leaked by undisposed anchors before restoring
  // the spies, so they can't fire in (and pollute) a later test.
  leakedResize.forEach((h) => window.removeEventListener('resize', h as EventListener))
  leakedResize = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Assert an observer was installed, then return it — a missing observer
 *  surfaces as a clear assertion failure instead of a TypeError on `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

/** Same, for the most-recently created observer (post-update). */
function lastObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances.at(-1)!
}

// ── Element fixture ──────────────────────────────────────────────────
//
// jsdom's `getBoundingClientRect` always returns zeros, so we stub it.
// `setRect` lets a test move the element after the anchor was created.

function buildElement(rect: { x: number; y: number; w: number; h: number }): {
  el: HTMLElement
  setRect: (next: typeof rect) => void
} {
  const el = document.createElement('div')
  let current = rect
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: current.x,
        y: current.y,
        left: current.x,
        top: current.y,
        right: current.x + current.w,
        bottom: current.y + current.h,
        width: current.w,
        height: current.h,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  return {
    el,
    setRect(next) {
      current = next
    },
  }
}

const opts = (o: ViewAnchorOptions): ViewAnchorOptions => o

// Initial synchronous publish
describe('createViewAnchor: initial sync publish', () => {
  it('publishes the rounded/clamped Placement once, synchronously, on create', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })
    createViewAnchor(el, opts({ visible: true, publish }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    })
  })

  it('rounds x/y (negatives allowed) and clamps width/height to >= 0', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: -3.4, y: 12.6, w: 100.49, h: 0.5 })
    createViewAnchor(el, opts({ visible: true, publish }))

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: -3, y: 13, width: 100, height: 1 },
    })
  })
})

// visible = false
describe('createViewAnchor: visible=false', () => {
  it('publishes { visible: false } immediately and does NOT observe', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })
    createViewAnchor(el, opts({ visible: false, publish }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    // No ResizeObserver and no resize listener while detached.
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(resizeAddSpy).not.toHaveBeenCalled()
  })

  it('does not retry a rejected hidden placement on its own; a repeated update() sends it again', () => {
    let accept = true
    const publish = vi.fn((p: Placement) => (p.visible ? undefined : accept))
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))
    const ro = firstObserver()

    accept = false
    handle.update({ visible: false, publish })
    expect(publish).toHaveBeenLastCalledWith({ visible: false })
    expect(ro.disconnected).toBe(true)
    publish.mockClear()

    // Hidden anchors observe nothing, so no later trigger retries the value.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    handle.pulse()
    expect(publish).not.toHaveBeenCalled()

    accept = true
    handle.update({ visible: false, publish })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
  })
})

// visible = true observation
describe('createViewAnchor: observation', () => {
  it('observes the target and adds a window resize listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.observed).toContain(el)
    expect(resizeAddSpy).toHaveBeenCalledTimes(1)
  })

  it('a ResizeObserver tick re-publishes SYNCHRONOUSLY (no RAF) with the current Placement', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()

    // Move the element, then fire the observer — the publish lands in the
    // same synchronous tick.
    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 5, y: 6, width: 120, height: 130 },
    })
  })

  it('a window resize tick re-publishes synchronously', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()

    setRect({ x: 1, y: 2, w: 50, h: 60 })
    window.dispatchEvent(new Event('resize'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 1, y: 2, width: 50, height: 60 },
    })
  })

  it('never schedules a requestAnimationFrame (RAF defer must not creep back)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))

    // Exercise every code path that could schedule a RAF.
    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()
    window.dispatchEvent(new Event('resize'))
    handle.update({ visible: false, publish })

    expect(rafSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })
})

describe('createViewAnchor: deduplication', () => {
  it('N ticks measuring the SAME rect → exactly ONE publish', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()

    // A same-frame burst of RO + resize, all measuring the same rect:
    // only the first emits, the rest dedup away.
    const ro = firstObserver()
    ro.fire()
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    ro.fire()

    expect(publish).not.toHaveBeenCalled() // rect unchanged since create
  })

  it('a tick whose rect differs from the create-time rect publishes once', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()

    setRect({ x: 7, y: 8, w: 110, h: 120 })
    firstObserver().fire()
    firstObserver().fire() // same rect again → deduped

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 7, y: 8, width: 110, height: 120 },
    })
  })

  it('ticks measuring DIFFERENT rects each publish; identical rects dedup', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()
    const ro = firstObserver()

    // Move → publish.
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    ro.fire()
    // Same rect twice more → deduped.
    ro.fire()
    ro.fire()
    // Move again → publish.
    setRect({ x: 5, y: 5, w: 200, h: 100 })
    ro.fire()
    // Move back to the first moved rect → distinct from last published → publish.
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    ro.fire()

    expect(publish).toHaveBeenCalledTimes(3)
    expect(publish.mock.calls.map((c) => c[0])).toEqual([
      { visible: true, bounds: { x: 5, y: 5, width: 100, height: 100 } },
      { visible: true, bounds: { x: 5, y: 5, width: 200, height: 100 } },
      { visible: true, bounds: { x: 5, y: 5, width: 100, height: 100 } },
    ])
  })
})

describe('createViewAnchor: dedupe option', () => {
  it('defaults to true: an identical-rect tick is still skipped when omitted', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, opts({ visible: true, publish }))
    publish.mockClear()

    firstObserver().fire()

    expect(publish).not.toHaveBeenCalled()
  })

  it('dedupe: false publishes on every ResizeObserver tick, even an identical rect', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, { visible: true, publish, dedupe: false })
    publish.mockClear()

    const ro = firstObserver()
    ro.fire()
    ro.fire()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
  })

  it('update() omitting dedupe resets it to the default (true)', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, { visible: true, publish, dedupe: false })
    publish.mockClear()

    // Re-apply without dedupe: update() applies the full configuration,
    // so the omitted flag resets to the default (true).
    handle.update({ visible: true, publish })
    publish.mockClear()
    firstObserver().fire()
    expect(publish).not.toHaveBeenCalled()

    // An explicit false switches dedup back off.
    handle.update({ visible: true, publish, dedupe: false })
    publish.mockClear()
    firstObserver().fire()
    expect(publish).toHaveBeenCalledTimes(1)
  })
})

describe('createViewAnchor: update()', () => {
  it('true → false: publishes { visible: false } immediately and stops observing', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))
    expect(firstObserver().disconnected).toBe(false)
    publish.mockClear()

    handle.update({ visible: false, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    // Observer disconnected and resize listener removed.
    expect(firstObserver().disconnected).toBe(true)
    expect(resizeRemoveSpy).toHaveBeenCalledTimes(1)
  })

  it('false → true: measures the current rect and starts observing', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 7, y: 8, w: 90, h: 110 })
    const handle = createViewAnchor(el, opts({ visible: false, publish }))
    // visible=false start: no observer.
    expect(FakeResizeObserver.instances).toHaveLength(0)
    publish.mockClear()

    handle.update({ visible: true, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 7, y: 8, width: 90, height: 110 },
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.observed).toContain(el)
  })

  it('swapping publish while visible routes new emits to the new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish: first }))
    first.mockClear()

    handle.update({ visible: true, publish: second })
    // Immediate re-publish goes to the new callback (apply() resets
    // lastPublished, so an unchanged rect still emits — see next test).
    expect(second).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })

    second.mockClear()
    setRect({ x: 5, y: 5, w: 100, h: 100 })
    lastObserver().fire()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('update() with an unchanged rect still forces one publish (lastPublished reset)', () => {
    // Zoom rides in the `publish` closure, not in `Placement`. A zoom change
    // re-calls update() with the same geometry but a new publish closure —
    // the anchor must re-emit so the new closure runs. `apply()` resets
    // `lastPublished = null` to guarantee one fresh publish.
    const first = vi.fn()
    const { el } = buildElement({ x: 12, y: 34, w: 56, h: 78 })
    createViewAnchor(el, opts({ visible: true, publish: first }))
    expect(first).toHaveBeenCalledTimes(1)

    // Same visible/measure, unchanged geometry, but a brand-new publish spy.
    const second = vi.fn()
    const handle = createViewAnchor(el, opts({ visible: true, publish: first }))
    handle.update({ visible: true, publish: second })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 12, y: 34, width: 56, height: 78 },
    })
  })
})

describe('createViewAnchor: dispose()', () => {
  it('disconnects the observer and removes the resize listener', () => {
    const publish = vi.fn()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))

    handle.dispose()

    expect(firstObserver().disconnected).toBe(true)
    expect(resizeRemoveSpy).toHaveBeenCalledTimes(1)
    // Teardown is synchronous and uses no RAF — nothing to cancel.
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('never publishes again after dispose (later RO/resize events are ignored)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))
    const ro = firstObserver()
    handle.dispose()
    publish.mockClear()

    // Move the element so a non-deduped rect WOULD publish if `disposed`
    // weren't read synchronously in every emit.
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('createViewAnchor: teardown safety', () => {
  it('a tick after dispose() does not publish (disposed read synchronously)', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))
    const ro = firstObserver()
    publish.mockClear()

    handle.dispose()
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()

    expect(publish).not.toHaveBeenCalled()
  })

  it('after update(visible=false), a later tick does not publish a real Placement', () => {
    const publish = vi.fn()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, opts({ visible: true, publish }))
    const ro = firstObserver()

    // Flip to visible=false → synchronous detach, observers stopped.
    handle.update({ visible: false, publish })
    expect(publish).toHaveBeenLastCalledWith({ visible: false })
    publish.mockClear()

    // A late tick must not republish a real Placement over the detach.
    setRect({ x: 999, y: 999, w: 999, h: 999 })
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

// Local type assertion so the file fails loudly if the Bounds shape drifts
// from what these tests assert against.
const _boundsShape: Bounds = { x: 0, y: 0, width: 0, height: 0 }
void _boundsShape

// ── display:none / first-frame guard (opt-in) ───────────────────────
//
// Opt-in hardening via `treatZeroAreaAsHidden?: boolean` (default false).
//
// When true, two additional behaviours apply:
//   First-frame guard — `visible:true` but measured rect has
//      `width === 0 || height === 0` → publishes `{ visible:false }` instead
//      of `{ visible:true, bounds:{...,0,0} }`. A non-zero box at position
//      (0,0) is still a normal `{ visible:true }`.
//   display:none guard — attaches an `IntersectionObserver`. When the target
//      goes display:none (IO reports not-intersecting + zero-area rect) →
//      publishes `{ visible:false }`. When it comes back → re-measures →
//      publishes `{ visible:true, bounds }`.
//
// Caller intent still wins: `visible:false` is detached regardless. A
// non-zero box at a negative/off-screen origin stays `visible:true`.
//
// This guard adds an IntersectionObserver, not a RAF — the "never schedules
// a requestAnimationFrame" invariant remains valid.

// A controllable fake IntersectionObserver (jsdom has none). Records observed
// elements + disconnect, captures every instance, and exposes `trigger(entries)`
// to synchronously invoke its callback with a partial entry list (only the
// fields the guard reads: `isIntersecting` + `boundingClientRect`).
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(public cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
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
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  // Drive the callback synchronously. Tests pass the minimal entry shape the
  // guard inspects; we widen to the full entry type so `cb` typechecks.
  trigger(
    entries: Array<{
      isIntersecting: boolean
      boundingClientRect: { width: number; height: number }
    }>,
  ): void {
    this.cb(
      entries as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    )
  }
}

describe('createViewAnchor — display:none / first-frame guard (opt-in)', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })
  // (The shared afterEach calls vi.unstubAllGlobals(), which removes the
  //  IntersectionObserver stub too — no extra teardown needed here.)

  /** Assert an IntersectionObserver was installed, then return it — a missing
   *  one surfaces as a clear assertion failure instead of a TypeError on `.trigger()`. */
  function firstIO(): FakeIntersectionObserver {
    expect(FakeIntersectionObserver.instances.length).toBeGreaterThanOrEqual(1)
    return FakeIntersectionObserver.instances[0]!
  }

  const HIDDEN: Placement = { visible: false }

  // a) first measure 0×0 with the guard ON → detach, not visible+0×0.
  it('a) treatZeroAreaAsHidden:true + first measure 0×0 → publishes { visible:false } (not visible:true+0×0)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 42, y: 99, w: 0, h: 0 })

    createViewAnchor(el, {
      visible: true,
      treatZeroAreaAsHidden: true,
      publish,
    })

    expect(publish).toHaveBeenCalledTimes(1)
    const p = publish.mock.calls[0]![0]
    expect(p).toEqual(HIDDEN)
    expect(p.visible).toBe(false)
    expect('bounds' in p).toBe(false)
    // Must NOT be the legitimate-0×0-visible value the default path emits.
    expect(p).not.toEqual({ visible: true, bounds: { x: 42, y: 99, width: 0, height: 0 } })
    // No RAF introduced by the guard.
    expect(rafSpy).not.toHaveBeenCalled()
  })

  // b) first measure non-zero box with the guard ON → normal visible publish.
  it('b) treatZeroAreaAsHidden:true + first measure non-zero box → publishes { visible:true, bounds }', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 10, y: 20, w: 300, h: 400 })

    createViewAnchor(el, {
      visible: true,
      treatZeroAreaAsHidden: true,
      publish,
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    })
    // Guard installs an IntersectionObserver on the target.
    expect(firstIO().observed).toContain(el)
  })

  // c) display:none round-trip: visible → IO display:none → detach → restore → visible.
  it('c) IO display:none transition publishes { visible:false }; a restored non-zero box re-publishes { visible:true, bounds }', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    createViewAnchor(el, {
      visible: true,
      treatZeroAreaAsHidden: true,
      publish,
    })
    // Initial: normal visible publish.
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 120 },
    })
    publish.mockClear()

    // Target goes display:none: IO reports not-intersecting + a zero-area box.
    setRect({ x: 0, y: 0, w: 0, h: 0 })
    firstIO().trigger([{ isIntersecting: false, boundingClientRect: { width: 0, height: 0 } }])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(HIDDEN)
    publish.mockClear()

    // Target comes back with a real box; a subsequent tick re-measures a
    // non-zero box → visible again.
    setRect({ x: 5, y: 6, w: 100, h: 120 })
    firstIO().trigger([{ isIntersecting: true, boundingClientRect: { width: 100, height: 120 } }])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 5, y: 6, width: 100, height: 120 },
    })
  })

  // d) caller visible:false wins — IO intersecting must NOT flip it to visible.
  it('d) caller visible:false → detached; an IO "intersecting" tick does NOT flip to visible:true', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    createViewAnchor(el, {
      visible: false,
      treatZeroAreaAsHidden: true,
      publish,
    })

    // Detached on create.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(HIDDEN)
    publish.mockClear()

    // Even if the guard's IO fires "intersecting" with a real box, caller
    // intent (visible:false) wins — no visible:true is published.
    if (FakeIntersectionObserver.instances.length > 0) {
      FakeIntersectionObserver.instances[0]!.trigger([
        { isIntersecting: true, boundingClientRect: { width: 100, height: 120 } },
      ])
    }

    expect(publish).not.toHaveBeenCalled()
  })

  // e) non-zero box at a negative/off-screen origin → visible:true, negative origin preserved.
  it('e) non-zero box at negative origin → { visible:true, bounds } (off-screen ≠ detach; negative origin kept)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: -50, y: -20, w: 300, h: 200 })

    createViewAnchor(el, {
      visible: true,
      treatZeroAreaAsHidden: true,
      publish,
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: -50, y: -20, width: 300, height: 200 },
    })
  })

  // f) default-off regression: WITHOUT the option, 0×0 stays visible:true+0×0.
  it('f) default (no treatZeroAreaAsHidden): 0×0 measure → { visible:true, bounds:0×0 } unchanged', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 42, y: 99, w: 0, h: 0 })

    createViewAnchor(el, { visible: true, publish })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 42, y: 99, width: 0, height: 0 },
    })
    // Default off must NOT install an IntersectionObserver.
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
  })

  // g) dispose disconnects the IO and no late IO callback publishes.
  it('g) dispose() disconnects the IntersectionObserver and a late IO trigger publishes nothing', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 5, y: 6, w: 100, h: 120 })

    const handle = createViewAnchor(el, {
      visible: true,
      treatZeroAreaAsHidden: true,
      publish,
    })
    const io = firstIO()
    expect(io.disconnected).toBe(false)

    handle.dispose()
    expect(io.disconnected).toBe(true)
    publish.mockClear()

    // A late IO callback after dispose must be inert.
    setRect({ x: 0, y: 0, w: 0, h: 0 })
    io.trigger([{ isIntersecting: false, boundingClientRect: { width: 0, height: 0 } }])

    expect(publish).not.toHaveBeenCalled()
  })

  it('update() with no flags resets treatZeroAreaAsHidden, followScroll, followGeometry, holdSelector, and dedupe to their defaults', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, {
      visible: true,
      publish,
      followScroll: true,
      followGeometry: true,
      treatZeroAreaAsHidden: true,
      holdSelector: null,
      dedupe: false,
    })
    publish.mockClear()

    // Baseline: treatZeroAreaAsHidden on installs a live IntersectionObserver.
    expect(firstIO().disconnected).toBe(false)

    // Baseline: dedupe off still publishes an identical rect.
    firstObserver().fire()
    expect(publish).toHaveBeenCalledTimes(1)
    publish.mockClear()

    // Baseline: followScroll on, combined with followGeometry on, means a
    // capture-phase scroll opens the frame-following window (schedules a
    // frame) rather than publishing synchronously — proof both flags are
    // live. (A single-flight rafId guard means only one such trigger can be
    // observed per anchor without a real RAF flush, so followGeometry's own
    // reset is checked separately via pulse() below, after the flags that
    // gate it have already changed.)
    window.dispatchEvent(new Event('scroll'))
    expect(rafSpy).toHaveBeenCalled()
    rafSpy.mockClear()

    // A full reset: update() with only { visible, publish }.
    handle.update({ visible: true, publish })
    publish.mockClear()

    // treatZeroAreaAsHidden → false: the guard's IntersectionObserver disconnects.
    expect(firstIO().disconnected).toBe(true)

    // dedupe → true: the same rect no longer republishes.
    firstObserver().fire()
    expect(publish).not.toHaveBeenCalled()

    // followGeometry → false: pulse() is now a no-op.
    handle.pulse()
    expect(rafSpy).not.toHaveBeenCalled()

    // followScroll → false: a scroll no longer triggers a re-measure or
    // opens frame following.
    window.dispatchEvent(new Event('scroll'))
    expect(rafSpy).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()

    // followGeometry → false and holdSelector → the default separator: turn
    // followGeometry back on without specifying holdSelector, then a
    // pointerdown on the default `[role="separator"]` opens frame following —
    // proving holdSelector fell back to its default instead of staying null.
    handle.update({ visible: true, publish, followGeometry: true })
    const splitter = document.createElement('div')
    splitter.setAttribute('role', 'separator')
    document.body.appendChild(splitter)
    splitter.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(rafSpy).toHaveBeenCalled()
  })
})

// ── scroll + frame-following loop (opt-in) ────
//
// Opt-in options on `createViewAnchor` (both default off):
//   followScroll?: boolean   — ancestor-scroll capture listener.
//   followGeometry?: boolean — frame-following loop.
//   pulse(durationMs?)       — open a frame-following window imperatively.
//
// `followGeometry` narrows the "never RAF" invariant to "event-driven publishes
// (ResizeObserver / window resize / scroll) are never RAF-deferred". The
// frame-following rAF is a polling mechanism that publishes synchronously
// within its own frame — not a deferral of an event-driven publish. Tests
// below re-pin that the default / event-driven paths still schedule no rAF.

// A controllable fake requestAnimationFrame. The shared `rafSpy` returns 0
// and stores nothing (regression guard only), so frame following needs a
// flushable queue. This block installs its own rAF/cancel stubs over the
// shared ones (cleared by the outer afterEach's vi.unstubAllGlobals()).
class FakeRaf {
  // Pending callbacks keyed by handle. A frame is "scheduled" while non-empty.
  private cbs = new Map<number, FrameRequestCallback>()
  private nextId = 1
  request = vi.fn((cb: FrameRequestCallback): number => {
    const id = this.nextId++
    this.cbs.set(id, cb)
    return id
  })
  cancel = vi.fn((id: number): void => {
    this.cbs.delete(id)
  })
  /** Drain the callbacks pending at call-time and run each once.
   *  Callbacks that re-request a frame land in the next flush. */
  flushFrame(ts = 0): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb(ts)
  }
  /** Whether a frame is currently scheduled. */
  get pending(): number {
    return this.cbs.size
  }
}

describe('createViewAnchor — scroll + frame-following loop (opt-in)', () => {
  let raf: FakeRaf

  beforeEach(() => {
    raf = new FakeRaf()
    // Install a controllable rAF over the shared `rafSpy`.
    vi.stubGlobal(
      'requestAnimationFrame',
      raf.request as unknown as typeof window.requestAnimationFrame,
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      raf.cancel as unknown as typeof window.cancelAnimationFrame,
    )
  })

  /** Build a `[role="separator"]` element; a capture-phase pointerdown on it
   *  opens a frame-following window. */
  function buildSplitter(): HTMLElement {
    const sep = document.createElement('div')
    sep.setAttribute('role', 'separator')
    document.body.appendChild(sep)
    return sep
  }

  /** Dispatch a capture-phase scroll on window. */
  function dispatchCaptureScroll(): void {
    window.dispatchEvent(new Event('scroll'))
  }

  /** Dispatch a bubbling pointerdown from `target`. */
  function dispatchPointerdown(target: HTMLElement): void {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  }

  /** Dispatch pointerup from `target` and on window. */
  function dispatchPointerup(target: HTMLElement): void {
    target.dispatchEvent(new Event('pointerup', { bubbles: true }))
    window.dispatchEvent(new Event('pointerup'))
  }

  type FollowOpts = Parameters<typeof createViewAnchor>[1]
  type PulseHandle = ReturnType<typeof createViewAnchor>
  const mk = (
    el: HTMLElement,
    o: { visible: boolean; publish: (p: Placement) => void } & {
      followScroll?: boolean
      followGeometry?: boolean
      holdSelector?: string | null
      dedupe?: boolean
    },
  ): PulseHandle => createViewAnchor(el, o as FollowOpts)

  // ── A. followScroll — capture-phase ancestor scroll ──────────

  // A1: capture scroll re-publishes the freshly-measured rect synchronously.
  it('A1) followScroll (followGeometry off): a capture-phase scroll re-publishes the new measured rect synchronously', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Ancestor scrolled → element's screen rect moved (y changed).
    setRect({ x: 0, y: -40, w: 100, h: 100 })
    dispatchCaptureScroll()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 0, y: -40, width: 100, height: 100 },
    })
    // With followGeometry OFF, scroll-follow is purely synchronous: no rAF.
    expect(raf.request).not.toHaveBeenCalled()
  })

  // A2: the scroll listener is registered with { capture:true } and removed
  //     on dispose. We assert via window.addEventListener / removeEventListener
  //     spies (the shared beforeEach already spies addEventListener; we read
  //     its recorded calls).
  it('A2) followScroll registers a capture-phase window scroll listener and removes it on dispose', () => {
    const addCalls: Array<[string, unknown, unknown]> = []
    const removeCalls: Array<[string, unknown, unknown]> = []
    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type: string, cb: unknown, optsArg?: unknown) => {
        addCalls.push([type, cb, optsArg])
      })
    const removeSpy = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation((type: string, cb: unknown, optsArg?: unknown) => {
        removeCalls.push([type, cb, optsArg])
      })

    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followScroll: true, publish })

    const scrollAdd = addCalls.find(([t]) => t === 'scroll')
    expect(scrollAdd, 'a window scroll listener must be registered').toBeDefined()
    // Capture phase — either `true` or `{ capture: true }`.
    const optArg = scrollAdd![2]
    const isCapture =
      optArg === true ||
      (typeof optArg === 'object' &&
        optArg !== null &&
        (optArg as { capture?: boolean }).capture === true)
    expect(isCapture, 'scroll listener must be capture-phase').toBe(true)

    const scrollCb = scrollAdd![1]
    handle.dispose()
    const scrollRemove = removeCalls.find(([t, cb]) => t === 'scroll' && cb === scrollCb)
    expect(scrollRemove, 'the same scroll listener must be removed on dispose').toBeDefined()

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  // A3: a followScroll capture-scroll OPENS the RAF frame-following window when
  //     followGeometry is ALSO on (so it follows every frame of a scroll
  //     burst, not just the one synchronous emit).
  it('A3) followScroll + followGeometry: a capture scroll opens the RAF frame following (a frame becomes scheduled)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, {
      visible: true,
      followScroll: true,
      followGeometry: true,
      publish,
    })
    // Idle: no followed frame yet.
    expect(raf.request).not.toHaveBeenCalled()

    dispatchCaptureScroll()

    // The scroll opened the windowed frame following → a frame is scheduled.
    expect(raf.request).toHaveBeenCalled()
    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // ── B. followGeometry — frame-following loop ─────

  // B-idle: IDLE (no scroll / pointerdown / pulse) schedules NO rAF.
  //   Frame following is windowed: static cost is exactly zero.
  it('B-idle) followGeometry on but idle: NO rAF is ever scheduled (windowed = zero static cost)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })

    // Even an ordinary ResizeObserver tick (event-driven) must not open the
    // frame following — it publishes synchronously instead (see B-sync below).
    setRect({ x: 1, y: 1, w: 100, h: 100 })
    firstObserver().fire()

    expect(raf.request).not.toHaveBeenCalled()
  })

  // B-open: a splitter pointerdown (capture, matching [role="separator"])
  //   opens frame following when followGeometry:true.
  it('B-open) a capture-phase pointerdown on a [role="separator"] opens the RAF frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()
    expect(raf.request).not.toHaveBeenCalled()

    dispatchPointerdown(splitter)

    expect(raf.request).toHaveBeenCalled()
    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // B-open-nonseparator: a pointerdown NOT on a separator must NOT open it.
  it('B-open-nonseparator) a pointerdown on a non-separator element does NOT open frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    const plain = document.createElement('div')
    document.body.appendChild(plain)

    dispatchPointerdown(plain)

    expect(raf.request).not.toHaveBeenCalled()
  })

  // B-follow: once open, each frame whose measured rect CHANGED publishes the
  //   new rect SYNCHRONOUSLY IN THAT rAF callback (not deferred to a nested
  //   rAF). We assert via rect values + that publish happened during flushFrame
  //   (i.e. exactly one publish per changed frame, not coalesced/deferred).
  it('B-follow) open frame following + rect changes each frame → publishes the new rect in-frame, one per changed frame', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter) // open the window
    publish.mockClear()

    // Frame 1: rect moved → publish in-frame.
    setRect({ x: 10, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 10, y: 0, width: 100, height: 100 },
    })
    // The publish happened DURING the rAF callback, not queued for another
    // frame: after the flush returned, the call count is already 1 (no nested
    // defer). The frame loop re-arms for the next frame (window still open).
    expect(raf.request.mock.calls.length).toBeGreaterThanOrEqual(2)

    // Frame 2: moved again → another in-frame publish.
    setRect({ x: 20, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 20, y: 0, width: 100, height: 100 },
    })
  })

  // B-close: after the pointer is RELEASED, N=2 consecutive UNCHANGED frames
  //   cancel the rAF (steady = stop) — no further frame scheduled. A steady run
  //   while the pointer is still HELD is a mid-drag pause and must NOT close
  //   (see follow-geometry-press-drag.test.ts); close is gated on pointerup,
  //   so this test releases before going steady.
  it('B-close) pointerup then N=2 consecutive unchanged frames → frame following stops (cancelAnimationFrame / no further frame scheduled)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter) // open
    // One changing frame to prove it's live, then release and go steady.
    setRect({ x: 30, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1) // still polling
    dispatchPointerup(splitter) // drag over → steady-close now permitted

    // Steady frame 1 (rect identical to last published) — not yet closed
    // (N=2 needs TWO consecutive identical frames).
    raf.flushFrame()
    // Steady frame 2 — now N=2 consecutive identical → close window.
    raf.flushFrame()

    // The frame loop cancelled / stopped re-arming: no frame is pending and a
    // further flush runs nothing (no new publishes, no re-scheduled frame).
    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })

  // dedupe:false does not change the steady-close rule: frame following still
  // closes after 2 consecutive identical frames (samePlacement is used to
  // count steady frames regardless of dedupe); it only makes those identical
  // frames ALSO publish, instead of being silently skipped.
  it('dedupe:false publishes every identical follow frame but still closes frame following after 2 steady frames', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, {
      visible: true,
      followGeometry: true,
      holdSelector: '[role="separator"]',
      dedupe: false,
      publish,
    })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    setRect({ x: 30, y: 0, w: 100, h: 100 })
    raf.flushFrame() // changed frame: publishes, resets steady counters
    dispatchPointerup(splitter)
    publish.mockClear()

    raf.flushFrame() // steady frame 1: identical rect, dedupe:false → still publishes
    expect(publish).toHaveBeenCalledTimes(1)
    raf.flushFrame() // steady frame 2: identical rect → publishes AND closes

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 30, y: 0, width: 100, height: 100 },
    })
    expect(raf.pending).toBe(0)
  })

  // Off-by-one regression lock: the cap must trip on exactly the 30th
  // consecutive invalid frame, not the 31st (a post-increment comparison
  // would let one extra frame through before closing).
  it('invalid-measure cap: the 29th consecutive invalid frame still polls, the 30th closes frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followGeometry: true, publish })
    publish.mockClear() // drop the synchronous initial-create publish
    handle.pulse()
    setRect({ x: Number.NaN, y: 0, w: 100, h: 100 })

    for (let frame = 0; frame < 29; frame++) raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    raf.flushFrame() // 30th consecutive invalid frame
    expect(raf.pending).toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })

  // Same off-by-one lock for the hidden-frame cap (treatZeroAreaAsHidden's 0×0
  // path): the 29th consecutive hidden frame still polls, the 30th closes.
  it('hidden-measure cap: the 29th consecutive 0×0 frame still polls, the 30th closes frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      treatZeroAreaAsHidden: true,
      publish,
    })
    publish.mockClear()
    handle.pulse()
    setRect({ x: 0, y: 0, w: 0, h: 0 })

    for (let frame = 0; frame < 29; frame++) raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    raf.flushFrame() // 30th consecutive hidden frame
    expect(raf.pending).toBe(0)
    // Hidden frames are never published by frame following — detaching is owned
    // by ResizeObserver/IntersectionObserver, not this poll.
    expect(publish).not.toHaveBeenCalledWith({ visible: false })
  })

  // ── F. pulse() — explicit window open ────────────────────────

  // F-open: pulse() opens frame following and it follows subsequent rect changes.
  it('F-open) pulse() opens frame following; it follows rect changes on subsequent frames', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followGeometry: true, publish })
    expect(raf.request).not.toHaveBeenCalled()

    handle.pulse()
    expect(raf.request).toHaveBeenCalled()
    publish.mockClear()

    // A transform/animation moved the rect (no DOM event) → frame following catches it.
    setRect({ x: 7, y: 9, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 7, y: 9, width: 100, height: 100 },
    })
  })

  // F-close: pulse()'d window auto-closes (after durationMs or once steady)
  //   — by steady frames (N=2 identical) here. After close, no frame pending.
  it('F-close) pulse() window auto-closes after it goes steady (N=2 identical frames)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, followGeometry: true, publish })

    handle.pulse()
    // One change, then steady.
    setRect({ x: 4, y: 4, w: 100, h: 100 })
    raf.flushFrame()
    raf.flushFrame() // steady 1
    raf.flushFrame() // steady 2 → close

    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })

  // ── Event-driven publishes stay SYNCHRONOUS even with frame following enabled;
  //    frame-following rAF publishes in-frame, not deferred. ──

  // B-sync: a ResizeObserver tick still publishes SYNCHRONOUSLY (in the event
  //   stack) WITHOUT scheduling a rAF, even with followGeometry enabled. This
  //   is the narrowing made concrete: event-driven ≠ RAF-deferred.
  it('with followGeometry ENABLED, a ResizeObserver tick publishes synchronously and schedules NO rAF', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, publish })
    publish.mockClear()

    setRect({ x: 3, y: 4, w: 100, h: 100 })
    firstObserver().fire()

    // Published in the synchronous RO tick…
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 3, y: 4, width: 100, height: 100 },
    })
    // …and the event-driven path did NOT route through a rAF (the invariant
    // survives, narrowed: event-driven publishes are never RAF-deferred).
    expect(raf.request).not.toHaveBeenCalled()
  })

  // Default-path "still no rAF": with followGeometry OFF / unset, NOTHING in
  //   this surface schedules a rAF — the original package-wide "never RAF"
  //   guarantee holds for the default + event-driven paths.
  it('followGeometry OFF (default): RO + resize + scroll-less lifecycle schedules NO rAF', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = mk(el, { visible: true, publish }) // followGeometry unset

    setRect({ x: 5, y: 6, w: 120, h: 130 })
    firstObserver().fire()
    window.dispatchEvent(new Event('resize'))
    handle.update({ visible: false, publish } as Parameters<typeof createViewAnchor>[1])

    expect(raf.request).not.toHaveBeenCalled()
    expect(raf.cancel).not.toHaveBeenCalled()
  })
})

// ── Pointer listeners mounted on demand ────────────────────────────────
//
// The pointerdown/pointerup/pointercancel/blur listener group exists only
// to detect a held press on holdSelector; it must be attached only while
// BOTH followGeometry and holdSelector are set, not just followGeometry.
describe('pointer listeners mounted on demand', () => {
  // The shared beforeEach already spies window.add/removeEventListener (to
  // track leaked 'resize' listeners) and forwards every call through to the
  // real DOM. Re-spying here would just reset that same mock's
  // implementation (vitest reuses an existing spy) and recurse, so this
  // reads calls off the existing spy instead of wrapping it again.
  function spyPointerListeners(): {
    addedTypes(): string[]
    removedTypes(): string[]
  } {
    const addMock = window.addEventListener as unknown as { mock: { calls: unknown[][] } }
    const removeMock = window.removeEventListener as unknown as { mock: { calls: unknown[][] } }
    const baseline = addMock.mock.calls.length
    const removeBaseline = removeMock.mock.calls.length
    return {
      addedTypes: () => addMock.mock.calls.slice(baseline).map((call) => call[0] as string),
      removedTypes: () =>
        removeMock.mock.calls.slice(removeBaseline).map((call) => call[0] as string),
    }
  }

  it('followGeometry on, holdSelector: null: no pointerdown listener is added on window', () => {
    const spy = spyPointerListeners()
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    createViewAnchor(el, { visible: true, followGeometry: true, holdSelector: null, publish })

    expect(spy.addedTypes()).not.toContain('pointerdown')
    expect(spy.addedTypes()).not.toContain('pointerup')
    expect(spy.addedTypes()).not.toContain('pointercancel')
  })

  it('followGeometry on, holdSelector omitted: pointer listeners are mounted by default', () => {
    const spy = spyPointerListeners()
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    createViewAnchor(el, { visible: true, followGeometry: true, publish })

    expect(spy.addedTypes()).toContain('pointerdown')
    expect(spy.addedTypes()).toContain('pointerup')
    expect(spy.addedTypes()).toContain('pointercancel')
  })

  it('update() setting holdSelector mounts the pointer listeners, and clearing it unmounts them', () => {
    const spy = spyPointerListeners()
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    const handle = createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      holdSelector: null,
      publish,
    })
    expect(spy.addedTypes()).not.toContain('pointerdown')

    handle.update({
      visible: true,
      followGeometry: true,
      holdSelector: '[role="separator"]',
      publish,
    })
    expect(spy.addedTypes()).toContain('pointerdown')

    handle.update({ visible: true, followGeometry: true, holdSelector: null, publish })
    expect(spy.removedTypes()).toContain('pointerdown')
    expect(spy.removedTypes()).toContain('pointerup')
    expect(spy.removedTypes()).toContain('pointercancel')
  })
})

// ── Invalid holdSelector throws synchronously ──────────────────────────
//
// holdSelector is fed to Element.matches(); a syntactically invalid
// selector must fail fast at creation/update time rather than surfacing
// later as an opaque error from inside a pointerdown handler.
describe('invalid holdSelector throws synchronously', () => {
  it('createViewAnchor throws synchronously for an invalid holdSelector', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    expect(() =>
      createViewAnchor(el, {
        visible: true,
        followGeometry: true,
        holdSelector: '[',
        publish,
      }),
    ).toThrow()
  })

  it('createViewAnchor throws a DOMException named SyntaxError, not a generic Error', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    try {
      createViewAnchor(el, { visible: true, followGeometry: true, holdSelector: '[', publish })
      throw new Error('expected createViewAnchor to throw')
    } catch (error) {
      expect((error as DOMException).name).toBe('SyntaxError')
    }
  })

  it('update() throws synchronously for an invalid holdSelector, leaving the previous selector in effect', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 10, h: 10 })
    const handle = createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      holdSelector: '[role="separator"]',
      publish,
    })

    expect(() =>
      handle.update({
        visible: true,
        followGeometry: true,
        holdSelector: '[',
        publish,
      }),
    ).toThrow()

    // The previous, valid holdSelector must still be in effect: a matching
    // pointerdown still opens the geometry frame following.
    const splitter = document.createElement('div')
    splitter.setAttribute('role', 'separator')
    document.body.appendChild(splitter)
    splitter.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(rafSpy).toHaveBeenCalled()
  })
})

// ── ViewAnchorHandle.update() does not accept `signal` ─────────────────
//
// `signal` is read once at creation only; update()'s type is
// `Omit<ViewAnchorOptions, 'signal'>` so a caller can't mistake passing it
// again for changing or clearing it.
type ViewAnchorUpdateOptions = Parameters<ReturnType<typeof createViewAnchor>['update']>[0]
const _updateRejectsSignal: ViewAnchorUpdateOptions = {
  visible: true,
  publish: () => {},
  // @ts-expect-error update()'s options type does not include `signal`
  signal: new AbortController().signal,
}
void _updateRejectsSignal
