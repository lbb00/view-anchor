import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { Placement } from '../src/types.js'

// ── press-pause-drag: the frame-following loop must NOT close
//    while the pointer is still held down ───────────────────────────────
//
// Locks the press-pause-drag behaviour of the `followGeometry` frame following.
//
// The windowed frame following closes on *steady* frames AFTER release
// (pointerup), NOT after N consecutive identical frames unconditionally — a
// press that pauses before the drag starts must not close the window mid-press
// and drop the drag.
//
// This file pins:
//   1. press-pause-drag: pointerdown → ≥2 static frames → rect starts moving →
//      the movement is STILL followed.
//   2. no-regression: pointerup → static frames → frame following still closes.

// ── Controllable fake requestAnimationFrame ─────────────────────────────────
class FakeRaf {
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
  /** Drain exactly the callbacks pending at call-time; a re-request lands in
   *  the next flush, so flushFrame() advances exactly one frame. */
  flushFrame(ts = 0): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb(ts)
  }
  /** Is a frame currently scheduled (frame-following window still open)? */
  get pending(): number {
    return this.cbs.size
  }
}

// ── Minimal ResizeObserver stub ──────────────────────────────────────────────
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
}

let raf: FakeRaf

beforeEach(() => {
  FakeResizeObserver.instances = []
  raf = new FakeRaf()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    raf.request as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal('cancelAnimationFrame', raf.cancel as unknown as typeof window.cancelAnimationFrame)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// jsdom's getBoundingClientRect returns zeros; stub it so tests can control
// the element's rect.
function buildElement(rect: { x: number; y: number; w: number; h: number }): {
  el: HTMLElement
  setRect: (next: { x: number; y: number; w: number; h: number }) => void
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

/** A `[role="separator"]` splitter: a capture-phase pointerdown matching it
 *  opens a frame-following window. */
function buildSplitter(): HTMLElement {
  const sep = document.createElement('div')
  sep.setAttribute('role', 'separator')
  document.body.appendChild(sep)
  return sep
}

function dispatchPointerdown(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

/** Dispatch a pointerup from the splitter so window capture/bubble listeners
 *  see it. Also dispatched on window directly in case the close is gated on
 *  a window-level pointerup. */
function dispatchPointerup(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerup', { bubbles: true }))
  window.dispatchEvent(new Event('pointerup'))
}

// new options aren't on the public types yet — cast through.
type FollowOpts = Parameters<typeof createViewAnchor>[1] & {
  followGeometry?: boolean
}
const mk = (
  el: HTMLElement,
  o: {
    visible: boolean
    publish: (p: Placement) => void
    followGeometry?: boolean
    holdSelector?: string | null
  },
): ReturnType<typeof createViewAnchor> => createViewAnchor(el, o as FollowOpts)

describe('createViewAnchor — press-pause-drag (followGeometry frame following must survive a held pause)', () => {
  // 1. THE BUG. pointerdown opens the window; the user then hesitates
  //    before dragging. While the pointer is still DOWN, static frames
  //    must NOT close frame following.
  it('pointerdown → static pause (≥2 identical frames) → drag moves: the drag is STILL followed', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()

    // Press the splitter — window opens, a frame is scheduled.
    dispatchPointerdown(splitter)
    expect(raf.request).toHaveBeenCalled()
    publish.mockClear()

    // Held pause: two consecutive identical frames. Under the buggy impl
    // these close the window even though the pointer is still down.
    raf.flushFrame() // static frame 1
    raf.flushFrame() // static frame 2

    // The drag begins: pointer never released, so frame following must still poll.
    setRect({ x: 25, y: 0, w: 100, h: 100 })
    raf.flushFrame()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 25, y: 0, width: 100, height: 100 },
    })

    // Further drag frames within the same press are still followed.
    setRect({ x: 50, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 50, y: 0, width: 100, height: 100 },
    })
  })

  // 1b. The window stays OPEN across a held static pause.
  it('frame-following window stays open (a frame stays scheduled) across a held static pause', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Several static held frames — pointer still down, must keep re-arming.
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()

    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  // 2. NO REGRESSION. After pointerup, a steady geometry must still close
  //    the window — frame following must not spin forever after a press.
  it('pointerup then steady frames → frame following still closes (does not spin forever)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    mk(el, { visible: true, followGeometry: true, holdSelector: '[role="separator"]', publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    // A real drag frame to prove it's live.
    setRect({ x: 30, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Release, then go steady (rect identical from here on).
    dispatchPointerup(splitter)
    // Give the close logic its consecutive-identical frames to converge.
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()
    raf.flushFrame()

    // Window must have closed: no frame pending and a further flush schedules nothing.
    const requestsBefore = raf.request.mock.calls.length
    raf.flushFrame()
    expect(raf.pending).toBe(0)
    expect(raf.request.mock.calls.length).toBe(requestsBefore)
  })

  // 3. A long held pause must not use up the hidden-frame budget.
  it('a long held pause followed by one transient hidden frame keeps following the drag', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      treatZeroAreaAsHidden: true,
      holdSelector: '[role="separator"]',
      publish,
    })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)
    for (let frame = 0; frame < 40; frame++) raf.flushFrame()
    publish.mockClear()

    setRect({ x: 0, y: 0, w: 0, h: 100 })
    raf.flushFrame()

    setRect({ x: 40, y: 0, w: 100, h: 100 })
    raf.flushFrame()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 40, y: 0, width: 100, height: 100 },
    })
  })
})
