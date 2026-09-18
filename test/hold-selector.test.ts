import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { Placement } from '../src/types.js'

// ── holdSelector — configurable press-and-hold target for the followGeometry
//    frame following, defaulting to `[role="separator"]`.
//
// This file pins:
//   (a) with holdSelector omitted, a pointerdown on the default
//       `[role="separator"]` element opens frame following.
//   (a2) with holdSelector explicitly null, that same pointerdown does NOT
//        open frame following.
//   (b) a custom holdSelector opens frame following on a matching pointerdown and
//       keeps it open (pointerHeld) across static frames while held.
//   (c) clearing holdSelector to null mid-hold lets steady frames close the
//       frame following even though the pointer was never released.

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

function buildSplitter(): HTMLElement {
  const sep = document.createElement('div')
  sep.setAttribute('role', 'separator')
  document.body.appendChild(sep)
  return sep
}

function buildDragHandle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'drag-handle'
  document.body.appendChild(el)
  return el
}

function dispatchPointerdown(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

describe('createViewAnchor — holdSelector (configurable press-and-hold target)', () => {
  it('(a) with holdSelector omitted, a pointerdown on a [role="separator"] opens frame following (default selector)', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, { visible: true, followGeometry: true, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)

    expect(raf.request).toHaveBeenCalled()
  })

  it('(a2) with holdSelector: null, a pointerdown on a [role="separator"] does not open frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, { visible: true, followGeometry: true, holdSelector: null, publish })
    const splitter = buildSplitter()

    dispatchPointerdown(splitter)

    expect(raf.request).not.toHaveBeenCalled()
  })

  it('(b) a custom holdSelector opens frame following on a matching pointerdown and stays open while held', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      holdSelector: '.drag-handle',
      publish,
    })
    const handle = buildDragHandle()

    dispatchPointerdown(handle)
    expect(raf.request).toHaveBeenCalled()
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Held pause: two consecutive identical frames would normally close the
    // window, but pointerHeld keeps it open while the press continues.
    raf.flushFrame()
    raf.flushFrame()
    expect(raf.pending).toBeGreaterThanOrEqual(1)
  })

  it('(c) clearing holdSelector to null mid-hold lets steady frames close frame following', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    const anchorHandle = createViewAnchor(el, {
      visible: true,
      followGeometry: true,
      holdSelector: '.drag-handle',
      publish,
    })
    const handle = buildDragHandle()

    dispatchPointerdown(handle)
    expect(raf.pending).toBeGreaterThanOrEqual(1)

    // Clear holdSelector while the pointer is still down (no pointerup fired).
    anchorHandle.update({
      visible: true,
      followGeometry: true,
      holdSelector: null,
      publish,
    })

    // Two consecutive identical (steady) frames now close frame following even
    // though the pointer was never released.
    raf.flushFrame()
    raf.flushFrame()
    expect(raf.pending).toBe(0)
  })
})
