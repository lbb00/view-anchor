import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { Placement } from '../src/types.js'

// ── followScroll — hybrid scroll listening ────
//
// When followScroll is enabled, the library uses a hybrid approach:
// 1. Window capture-phase listener (fallback): catches all scrolls including
//    overflow:hidden + programmatic scrollLeft/Top, works before element is
//    connected or after reparenting without update().
// 2. Scrollable ancestor listeners: catch scrolls that cannot reach window.
//
// Events caught by window must not be handled again by ancestor listeners.
//
// This file pins:
//   (a) scroll on a scrollable ancestor element triggers re-measurement
//   (b) scroll on window still triggers re-measurement
//   (c) listeners are removed from ancestors on dispose (no memory leak)
//   (d) ancestors are re-collected when options are updated
//   (dedupe) one scroll event is handled once even with dedupe disabled

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

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
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

function buildScrollableContainer(): HTMLElement {
  const container = document.createElement('div')
  container.style.overflow = 'auto'
  container.style.overflowX = 'auto'
  container.style.overflowY = 'auto'
  document.body.appendChild(container)
  return container
}

describe('createViewAnchor — followScroll with scrollable ancestors', () => {
  it('(dedupe) ancestor scroll publishes once even with window capture fallback', () => {
    const scrollContainer = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    // The window capture listener handles connected ancestors once.
    createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Ancestor scrolled; the same event reaches window first.
    setRect({ x: 0, y: -40, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -40, width: 100, height: 100 },
    })
  })

  it('handles a connected ancestor scroll once even when dedupe is disabled', () => {
    const scrollContainer = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)
    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, {
      visible: true,
      followScroll: true,
      dedupe: false,
      publish,
    })
    publish.mockClear()

    setRect({ x: 0, y: -40, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -40, width: 100, height: 100 },
    })
    handle.dispose()
  })

  it('still handles scrolls on a detached scrollable ancestor', () => {
    const scrollContainer = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)
    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    scrollContainer.remove()
    setRect({ x: 0, y: -40, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledTimes(1)
    handle.dispose()
  })

  it('handles a scroll inside a shadow root that cannot reach window', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const scrollContainer = document.createElement('div')
    scrollContainer.style.overflowY = 'auto'
    shadow.appendChild(scrollContainer)
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)
    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    setRect({ x: 0, y: -40, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledTimes(1)
    handle.dispose()
  })

  it('follows a scrollable ancestor across nested shadow roots', () => {
    const outerHost = document.createElement('div')
    document.body.appendChild(outerHost)
    const outerRoot = outerHost.attachShadow({ mode: 'open' })
    const scrollContainer = document.createElement('div')
    scrollContainer.style.overflowY = 'auto'
    outerRoot.appendChild(scrollContainer)
    const innerHost = document.createElement('div')
    scrollContainer.appendChild(innerHost)
    const innerRoot = innerHost.attachShadow({ mode: 'open' })
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    innerRoot.appendChild(el)
    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    setRect({ x: 0, y: -30, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      visible: true,
      bounds: { x: 0, y: -30, width: 100, height: 100 },
    })
    handle.dispose()
  })

  it('follows programmatic scrolling on an overflow:hidden container inside a shadow root', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const scrollContainer = document.createElement('div')
    scrollContainer.style.overflowY = 'hidden'
    shadow.appendChild(scrollContainer)
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)
    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    scrollContainer.scrollTop = 30
    setRect({ x: 0, y: -30, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      visible: true,
      bounds: { x: 0, y: -30, width: 100, height: 100 },
    })
    handle.dispose()
  })

  it('(window-capture-fallback) scroll on unrelated element still triggers via window capture fallback', () => {
    const scrollContainer = buildScrollableContainer()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    // Create an unrelated scrollable sibling (not an ancestor of el)
    const unrelatedContainer = document.createElement('div')
    unrelatedContainer.style.overflow = 'auto'
    unrelatedContainer.style.overflowX = 'auto'
    unrelatedContainer.style.overflowY = 'auto'
    document.body.appendChild(unrelatedContainer)

    const publish = vi.fn<(p: Placement) => void>()
    createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Scroll on unrelated sibling - window capture fallback catches it.
    // This is intentional: the capture fallback ensures correctness for
    // overflow:hidden + programmatic scroll and reparent scenarios.
    // With dedupe:true (default), an unchanged rect won't publish.
    unrelatedContainer.dispatchEvent(new Event('scroll'))

    // Since rect is unchanged, dedupe prevents publish
    expect(publish).not.toHaveBeenCalled()
  })

  it('(a) scroll on a scrollable ancestor element triggers re-measurement', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })

    const scrollContainer = buildScrollableContainer()
    scrollContainer.appendChild(el)

    createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Ancestor scrolled → element's screen rect moved (y changed).
    setRect({ x: 0, y: -40, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -40, width: 100, height: 100 },
    })
  })

  it('(b) window scroll still triggers re-measurement', () => {
    const publish = vi.fn<(p: Placement) => void>()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })

    const scrollContainer = buildScrollableContainer()
    scrollContainer.appendChild(el)

    createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Window scrolled
    setRect({ x: 0, y: -20, w: 100, h: 100 })
    window.dispatchEvent(new Event('scroll', { bubbles: true }))

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -20, width: 100, height: 100 },
    })
  })

  it('(c) listeners are removed from ancestors on dispose', () => {
    const scrollContainer = buildScrollableContainer()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const removeSpy = vi.spyOn(scrollContainer, 'removeEventListener')

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })

    handle.dispose()

    const scrollRemove = removeSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(scrollRemove, 'scroll listener should be removed from ancestor').toBeDefined()
  })

  it('(d) nested scrollable containers: all ancestors get listeners', () => {
    const outerContainer = buildScrollableContainer()
    const innerContainer = document.createElement('div')
    innerContainer.style.overflow = 'scroll'
    innerContainer.style.overflowX = 'scroll'
    innerContainer.style.overflowY = 'scroll'
    outerContainer.appendChild(innerContainer)

    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    innerContainer.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Inner container scrolled
    setRect({ x: 0, y: -10, w: 100, h: 100 })
    innerContainer.dispatchEvent(new Event('scroll'))

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -10, width: 100, height: 100 },
    })
    publish.mockClear()

    // Outer container scrolled
    setRect({ x: 0, y: -30, w: 100, h: 100 })
    outerContainer.dispatchEvent(new Event('scroll'))

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -30, width: 100, height: 100 },
    })
  })

  it('(e) non-scrollable ancestors do not get listeners', () => {
    const nonScrollable = document.createElement('div')
    nonScrollable.style.overflow = 'visible'
    document.body.appendChild(nonScrollable)

    const addSpy = vi.spyOn(nonScrollable, 'addEventListener')

    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    nonScrollable.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    createViewAnchor(el, { visible: true, followScroll: true, publish })

    const scrollAdd = addSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(scrollAdd, 'non-scrollable ancestor should not get scroll listener').toBeUndefined()
  })

  it('(f) followScroll off does not attach ancestor listeners', () => {
    const scrollContainer = buildScrollableContainer()
    const addSpy = vi.spyOn(scrollContainer, 'addEventListener')

    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    createViewAnchor(el, { visible: true, followScroll: false, publish })

    const scrollAdd = addSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(
      scrollAdd,
      'ancestor should not get scroll listener when followScroll is off',
    ).toBeUndefined()
  })

  it('(g) update() turns followScroll on: ancestors get listeners', () => {
    const scrollContainer = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: false, publish })
    publish.mockClear()

    // Scroll before enabling followScroll: no publish
    setRect({ x: 0, y: -10, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).not.toHaveBeenCalled()

    // Enable followScroll
    handle.update({ visible: true, followScroll: true, publish })
    publish.mockClear()

    // Scroll after enabling: should publish
    setRect({ x: 0, y: -20, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -20, width: 100, height: 100 },
    })
  })

  it('(h) update() turns followScroll off: ancestor listeners removed', () => {
    const scrollContainer = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Disable followScroll
    handle.update({ visible: true, followScroll: false, publish })
    publish.mockClear()

    // Scroll after disabling: should not publish
    setRect({ x: 0, y: -30, w: 100, h: 100 })
    scrollContainer.dispatchEvent(new Event('scroll'))
    expect(publish).not.toHaveBeenCalled()
  })

  it('(i) update() recollects ancestors when target is reparented', () => {
    const containerA = buildScrollableContainer()
    const containerB = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    containerA.appendChild(el)

    const removeSpyA = vi.spyOn(containerA, 'removeEventListener')
    const addSpyB = vi.spyOn(containerB, 'addEventListener')

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })
    publish.mockClear()

    // Move element from container A to container B
    containerB.appendChild(el)

    // Call update() to trigger ancestor recollection
    handle.update({ visible: true, followScroll: true, publish })

    // Verify old ancestor listener was removed from containerA
    const removeCall = removeSpyA.mock.calls.find(([type]) => type === 'scroll')
    expect(removeCall, 'old ancestor listener should be removed').toBeDefined()

    // Verify new ancestor listener was added to containerB
    const addCall = addSpyB.mock.calls.find(([type]) => type === 'scroll')
    expect(addCall, 'new ancestor listener should be added').toBeDefined()

    // Scroll on new container B should trigger
    publish.mockClear()
    setRect({ x: 0, y: -20, w: 100, h: 100 })
    containerB.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: -20, width: 100, height: 100 },
    })
  })

  it('(j) dispose clears ancestor array to avoid memory leaks', () => {
    const scrollContainer = buildScrollableContainer()
    const { el } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    scrollContainer.appendChild(el)

    const removeSpy = vi.spyOn(scrollContainer, 'removeEventListener')
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })

    handle.dispose()

    // Verify ancestor listener was removed
    const ancestorRemove = removeSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(ancestorRemove, 'ancestor scroll listener should be removed on dispose').toBeDefined()

    // Verify window listener was removed (capture phase)
    const windowRemove = windowRemoveSpy.mock.calls.find(([type]) => type === 'scroll')
    expect(windowRemove, 'window scroll listener should be removed on dispose').toBeDefined()
  })

  it('(k) recollect on update clears old ancestor listeners even if element leaves DOM', () => {
    const containerA = buildScrollableContainer()
    const { el, setRect } = buildElement({ x: 0, y: 0, w: 100, h: 100 })
    containerA.appendChild(el)

    const removeSpyA = vi.spyOn(containerA, 'removeEventListener')

    const publish = vi.fn<(p: Placement) => void>()
    const handle = createViewAnchor(el, { visible: true, followScroll: true, publish })

    // Remove containerA from DOM (simulating panel close)
    containerA.remove()

    // Create a new container and move element there
    const containerB = buildScrollableContainer()
    containerB.appendChild(el)

    // Call update() — old listener on containerA should be cleaned up
    handle.update({ visible: true, followScroll: true, publish })

    // Verify old listener was removed from containerA
    const removeCall = removeSpyA.mock.calls.find(([type]) => type === 'scroll')
    expect(removeCall, 'old ancestor listener should be removed on recollect').toBeDefined()

    // New container should work
    publish.mockClear()
    setRect({ x: 0, y: -10, w: 100, h: 100 })
    containerB.dispatchEvent(new Event('scroll'))
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
