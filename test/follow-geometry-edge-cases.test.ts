import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { Placement } from '../src/types.js'

// ── followGeometry frame following edge cases ──────────────────────────────────
//
// Pins two behaviours of the frame-following loop:
//
//   1. A publish() that keeps rejecting a moved rect must not prevent the
//      frame following from ever closing. Steadiness is based on what was *measured*
//      frame over frame, not what was *accepted*.
//   2. pulse(durationMs)'s deadline is an idle-window bound. It must not cut
//      off a press-and-hold: the hold has no time limit.

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
  flushFrame(ts = 0): void {
    const pending = [...this.cbs.entries()]
    this.cbs.clear()
    for (const [, cb] of pending) cb(ts)
  }
  get pending(): number {
    return this.cbs.size
  }
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
}

let raf: FakeRaf
let nowMs = 0

beforeEach(() => {
  FakeResizeObserver.instances = []
  raf = new FakeRaf()
  nowMs = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    raf.request as unknown as typeof window.requestAnimationFrame,
  )
  vi.stubGlobal('cancelAnimationFrame', raf.cancel as unknown as typeof window.cancelAnimationFrame)
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

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

function dispatchPointerdown(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

function dispatchPointerup(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerup', { bubbles: true }))
  window.dispatchEvent(new Event('pointerup'))
}

describe('createViewAnchor — frame-following steadiness is independent of publish() accepting the frame', () => {
  it('closes frame following after steady frames even while publish keeps rejecting the moved rect', () => {
    const publish = vi.fn<(p: Placement) => boolean>()
    let rejecting = false
    publish.mockImplementation(() => !rejecting)
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, { visible: true, followGeometry: true, publish })
    publish.mockClear()

    // Accept the initial placement, then move the target and start rejecting
    // every publish attempt from here on.
    setRect({ x: 10, y: 0, w: 100, h: 100 })
    rejecting = true
    handle.pulse()
    expect(raf.pending).toBe(1)

    // Rect stays put at x=10 for several frames. Each frame must still retry
    // publish (it differs from the last *accepted* value), but frame following
    // must recognize the measurement itself is steady and close.
    for (let i = 0; i < 5 && raf.pending > 0; i++) raf.flushFrame()

    expect(raf.pending).toBe(0)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 10, y: 0, width: 100, height: 100 },
    })
    expect(publish.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('createViewAnchor — pulse(durationMs) does not cut off an active press-and-hold', () => {
  it('keeps frame following open past the pulse deadline while a matching pointer is held, then closes on steady frames after release', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const handle = createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      holdSelector: '.drag-handle',
      publish,
    })
    const dragHandle = document.createElement('div')
    dragHandle.className = 'drag-handle'
    document.body.appendChild(dragHandle)

    handle.pulse(5)
    dispatchPointerdown(dragHandle)
    expect(raf.pending).toBe(1)

    // Time moves past the 5ms pulse deadline while the pointer is still down.
    nowMs = 100
    setRect({ x: 20, y: 0, w: 100, h: 100 })
    raf.flushFrame()

    // The expired deadline must not have closed the window: a frame is still
    // scheduled and the moved rect was followed.
    expect(raf.pending).toBe(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 20, y: 0, width: 100, height: 100 },
    })

    dispatchPointerup(dragHandle)
    raf.flushFrame()
    raf.flushFrame()
    expect(raf.pending).toBe(0)
  })
})
