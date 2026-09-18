import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createViewAnchor } from '../src/view-anchor.js'
import type { Placement } from '../src/types.js'

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false
  constructor(_callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(_target: Element): void {}
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  disconnected = false
  constructor(_callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(_target: Element): void {}
  disconnect(): void {
    this.disconnected = true
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  unobserve(_target: Element): void {}
  root = null
  rootMargin = ''
  thresholds: ReadonlyArray<number> = []
}

class FakeRaf {
  private callbacks = new Map<number, FrameRequestCallback>()
  private nextId = 1
  request = vi.fn((callback: FrameRequestCallback): number => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  })
  cancel = vi.fn((id: number): void => {
    this.callbacks.delete(id)
  })
  flush(): void {
    const pending = [...this.callbacks.values()]
    this.callbacks.clear()
    pending.forEach((callback) => callback(0))
  }
  get pending(): number {
    return this.callbacks.size
  }
}

function element(): HTMLElement {
  const target = document.createElement('div')
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect)
  return target
}

function splitter(): HTMLElement {
  const target = document.createElement('div')
  target.setAttribute('role', 'separator')
  document.body.append(target)
  return target
}

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

describe('createViewAnchor dynamic lifecycle options', () => {
  let raf: FakeRaf

  beforeEach(() => {
    FakeResizeObserver.instances = []
    FakeIntersectionObserver.instances = []
    raf = new FakeRaf()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('requestAnimationFrame', raf.request)
    vi.stubGlobal('cancelAnimationFrame', raf.cancel)
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reconfigures guard, scroll, and geometry follow without duplicate resources', () => {
    const publish = vi.fn<(placement: Placement) => void>()
    const target = element()
    const handle = createViewAnchor(target, { visible: true, publish })

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances).toHaveLength(0)

    handle.update({
      visible: true,
      publish,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances).toHaveLength(1)

    handle.update({
      visible: true,
      publish,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
    })
    expect(FakeIntersectionObserver.instances).toHaveLength(1)

    const drag = splitter()
    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(raf.pending).toBe(1)

    handle.update({
      visible: true,
      publish,
      treatZeroAreaAsHidden: false,
      followScroll: false,
      followGeometry: false,
    })
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)
    expect(raf.pending).toBe(0)
    window.dispatchEvent(new Event('scroll'))
    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(raf.pending).toBe(0)

    handle.update({
      visible: false,
      publish,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
    })
    handle.update({
      visible: true,
      publish,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
    })
    expect(FakeIntersectionObserver.instances).toHaveLength(2)
    handle.dispose()
  })

  it('resets treatZeroAreaAsHidden/followScroll/followGeometry to their defaults across an update that omits them', () => {
    const publish = vi.fn<(placement: Placement) => void>()
    const target = element()
    const handle = createViewAnchor(target, {
      visible: true,
      publish,
      treatZeroAreaAsHidden: true,
      followScroll: true,
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    expect(FakeIntersectionObserver.instances).toHaveLength(1)

    // update() with only { visible, publish } resets all other flags to defaults.
    handle.update({ visible: true, publish })
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)

    const drag = splitter()
    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(raf.pending).toBe(0)

    // Passing followGeometry back on re-enables it.
    handle.update({ visible: true, publish, followGeometry: true })
    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(raf.pending).toBe(1)

    // An explicit `false` still turns a flag off.
    handle.update({ visible: true, publish, followGeometry: false })
    expect(raf.pending).toBe(0)

    handle.dispose()
  })

  it('uses the latest treatZeroAreaAsHidden setting for its synchronous update publish', () => {
    let collapsed = false
    const target = document.createElement('div')
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: collapsed ? 0 : 100,
          bottom: 100,
          width: collapsed ? 0 : 100,
          height: 100,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    const publish = vi.fn<(placement: Placement) => void>()
    const handle = createViewAnchor(target, { visible: true, publish })

    collapsed = true
    handle.update({ visible: true, publish, treatZeroAreaAsHidden: true })
    expect(publish).toHaveBeenLastCalledWith({ visible: false })

    handle.update({ visible: true, publish, treatZeroAreaAsHidden: false })
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 0, height: 100 },
    })
    handle.dispose()
  })

  it('pointercancel and window blur release a drag, close after steady frames, and allow the next drag', () => {
    const publish = vi.fn<(placement: Placement) => void>()
    const handle = createViewAnchor(element(), {
      visible: true,
      publish,
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    const drag = splitter()

    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    drag.dispatchEvent(new Event('pointercancel', { bubbles: true }))
    window.dispatchEvent(new Event('pointercancel'))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)

    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    drag.dispatchEvent(new Event('pointerup', { bubbles: true }))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)

    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)

    handle.dispose()
    window.dispatchEvent(new Event('pointercancel'))
    window.dispatchEvent(new Event('blur'))
    drag.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(raf.pending).toBe(0)
  })

  it('ignores a different pointer ending while the splitter pointer is still held', () => {
    const handle = createViewAnchor(element(), {
      visible: true,
      publish: vi.fn<(placement: Placement) => void>(),
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    const drag = splitter()

    drag.dispatchEvent(pointerEvent('pointerdown', 1))
    window.dispatchEvent(pointerEvent('pointerup', 2))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(1)

    window.dispatchEvent(pointerEvent('pointerup', 1))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)
    handle.dispose()
  })

  it('does not leave a RAF after publish synchronously disables geometry follow', () => {
    const target = element()
    let x = 0
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          x,
          y: 0,
          left: x,
          top: 0,
          right: x + 100,
          bottom: 100,
          width: 100,
          height: 100,
          toJSON: () => ({}),
        }) as DOMRect,
    )
    let disabled = false
    const publish = vi.fn<(placement: Placement) => void>((placement) => {
      if (!disabled && placement.visible && placement.bounds.x === 10) {
        disabled = true
        handle.update({ visible: true, publish, followGeometry: false })
      }
    })
    const handle = createViewAnchor(target, {
      visible: true,
      publish,
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })

    splitter().dispatchEvent(pointerEvent('pointerdown', 1))
    expect(raf.pending).toBe(1)
    x = 10
    raf.flush()

    expect(raf.pending).toBe(0)
  })

  it('rolls back every listener and observer when the first publish throws during creation', () => {
    const target = element()
    const controller = new AbortController()
    const signalRemoveSpy = vi.spyOn(controller.signal, 'removeEventListener')
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const publish = vi.fn<(placement: Placement) => void>(() => {
      throw new Error('boom')
    })

    expect(() =>
      createViewAnchor(target, {
        visible: true,
        publish,
        treatZeroAreaAsHidden: true,
        followScroll: true,
        followGeometry: true,
        holdSelector: '[role="separator"]',
        signal: controller.signal,
      }),
    ).toThrow('boom')

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true)
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)
    expect(windowRemoveSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('scroll', expect.any(Function), expect.anything())
    expect(windowRemoveSpy).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function),
      expect.anything(),
    )
    expect(windowRemoveSpy).toHaveBeenCalledWith(
      'pointerup',
      expect.any(Function),
      expect.anything(),
    )
    expect(windowRemoveSpy).toHaveBeenCalledWith(
      'pointercancel',
      expect.any(Function),
      expect.anything(),
    )
    expect(windowRemoveSpy).toHaveBeenCalledWith('blur', expect.any(Function))
    expect(signalRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('releases frame following only once every held pointer has been released (later-first release order)', () => {
    const handle = createViewAnchor(element(), {
      visible: true,
      publish: vi.fn<(placement: Placement) => void>(),
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    const drag = splitter()

    drag.dispatchEvent(pointerEvent('pointerdown', 1))
    drag.dispatchEvent(pointerEvent('pointerdown', 2))
    expect(raf.pending).toBe(1)

    // Release the first pointer while the second is still held: must stay open.
    window.dispatchEvent(pointerEvent('pointerup', 1))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(1)

    // Release the second (last) pointer: now steady frames close it.
    window.dispatchEvent(pointerEvent('pointerup', 2))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)
    handle.dispose()
  })

  it('releases frame following only once every held pointer has been released (earlier-first release order)', () => {
    const handle = createViewAnchor(element(), {
      visible: true,
      publish: vi.fn<(placement: Placement) => void>(),
      followGeometry: true,
      holdSelector: '[role="separator"]',
    })
    const drag = splitter()

    drag.dispatchEvent(pointerEvent('pointerdown', 1))
    drag.dispatchEvent(pointerEvent('pointerdown', 2))
    expect(raf.pending).toBe(1)

    // Release the second pointer while the first is still held: must stay open.
    window.dispatchEvent(pointerEvent('pointerup', 2))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(1)

    // Release the first (last) pointer: now steady frames close it.
    window.dispatchEvent(pointerEvent('pointerup', 1))
    raf.flush()
    raf.flush()
    expect(raf.pending).toBe(0)
    handle.dispose()
  })
})
