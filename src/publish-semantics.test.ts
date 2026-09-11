import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSizeAdvertiser } from './size-advertiser.js'
import { createPlacementAnchor, createViewAnchor } from './view-anchor.js'
import type { AdvertisedSize, Bounds, Placement, Publisher } from './types.js'

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(element: Element): void { this.observed.push(element) }
  disconnect(): void {}
  fire(): void { this.callback([], this as unknown as ResizeObserver) }
  fireSize(blockSize: number): void {
    this.callback([{ borderBoxSize: [{ blockSize, inlineSize: 0 }] }] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver)
  }
}

interface Frame {
  id: number
  callback: () => void
}
let frames: Frame[] = []
let nextFrameId = 0

beforeEach(() => {
  FakeResizeObserver.instances = []
  frames = []
  nextFrameId = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', ((callback: () => void) => {
    const id = ++nextFrameId
    frames.push({ id, callback })
    return id
  }) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id)
  }) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function flushFrame(): void {
  const queued = frames
  frames = []
  queued.forEach((frame) => frame.callback())
}

function element(rect = { left: 1, top: 2, width: 30, height: 40 }): {
  el: HTMLElement
  setRect(next: typeof rect): void
} {
  let current = rect
  const el = document.createElement('div')
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => ({
    left: current.left, top: current.top, width: current.width, height: current.height,
  }) as DOMRect)
  return { el, setRect: (next) => { current = next } }
}

describe('publish acceptance', () => {
  it('retries rejected and thrown forward publishes, while preserving a re-entrant inner baseline', () => {
    const { el, setRect } = element()
    const calls: Bounds[] = []
    let behavior: 'accept' | 'reject' | 'throw' | 'reentrant' = 'accept'
    const anchor: { handle?: ReturnType<typeof createViewAnchor> } = {}
    const inner = vi.fn<(value: Bounds) => void>()
    const publish: Publisher<Bounds> = (value) => {
      calls.push(value)
      if (behavior === 'reject') return false
      if (behavior === 'throw') throw new Error('transport unavailable')
      if (behavior === 'reentrant') {
        anchor.handle!.update({ present: true, publish: inner })
        return false
      }
    }
    anchor.handle = createViewAnchor(el, { present: true, publish })
    calls.length = 0
    setRect({ left: 3, top: 2, width: 30, height: 40 })
    behavior = 'reject'
    FakeResizeObserver.instances[0]!.fire()
    behavior = 'accept'
    FakeResizeObserver.instances[0]!.fire()
    expect(calls).toHaveLength(2)

    behavior = 'throw'
    setRect({ left: 4, top: 2, width: 30, height: 40 })
    expect(() => FakeResizeObserver.instances[0]!.fire()).toThrow('transport unavailable')
    behavior = 'accept'
    FakeResizeObserver.instances[0]!.fire()
    expect(calls).toHaveLength(4)

    behavior = 'reentrant'
    setRect({ left: 5, top: 2, width: 30, height: 40 })
    FakeResizeObserver.instances[0]!.fire()
    // The rejected outer call must not restore its stale candidate over the
    // synchronous update() publish made by the inner callback.
    FakeResizeObserver.instances.at(-1)!.fire()
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('retries rejected and thrown placement publishes', () => {
    const { el, setRect } = element()
    let result: boolean | undefined = undefined
    const publish = vi.fn<(value: Placement) => boolean | undefined>(() => result)
    createPlacementAnchor(el, { visible: true, publish })
    publish.mockClear()
    setRect({ left: 4, top: 2, width: 30, height: 40 })
    result = false
    FakeResizeObserver.instances[0]!.fire()
    result = undefined
    FakeResizeObserver.instances[0]!.fire()
    expect(publish).toHaveBeenCalledTimes(2)

    setRect({ left: 5, top: 2, width: 30, height: 40 })
    publish.mockImplementationOnce(() => { throw new Error('placement down') })
    expect(() => FakeResizeObserver.instances[0]!.fire()).toThrow('placement down')
    FakeResizeObserver.instances[0]!.fire()
    expect(publish).toHaveBeenCalledTimes(4)
  })

  it('retries rejected and thrown reverse publishes', () => {
    let state: 'reject' | 'throw' | 'accept' = 'reject'
    const publish = vi.fn<(value: AdvertisedSize) => boolean | undefined>(() => {
      if (state === 'reject') return false
      if (state === 'throw') throw new Error('reverse down')
    })
    createSizeAdvertiser(document.createElement('div'), { axis: 'block', publish })
    const observer = FakeResizeObserver.instances[0]!
    observer.fireSize(80)
    flushFrame()
    state = 'accept'
    observer.fireSize(80)
    flushFrame()
    expect(publish).toHaveBeenCalledTimes(2)

    state = 'throw'
    observer.fireSize(90)
    expect(() => flushFrame()).toThrow('reverse down')
    state = 'accept'
    observer.fireSize(90)
    flushFrame()
    expect(publish).toHaveBeenCalledTimes(4)
  })
})

describe('automatic geometry rejects non-finite DOMRect fields', () => {
  const fields = ['left', 'top', 'width', 'height'] as const
  const invalids = [Number.NaN, Number.POSITIVE_INFINITY]

  for (const field of fields) {
    for (const invalid of invalids) {
      it(`does not publish a ${String(invalid)} ${field}, and keeps the last valid forward baseline`, () => {
        const { el, setRect } = element()
        const publish = vi.fn<(value: Bounds) => void>()
        createViewAnchor(el, { present: true, publish })
        publish.mockClear()
        setRect({ left: 1, top: 2, width: 30, height: 40, [field]: invalid })
        FakeResizeObserver.instances[0]!.fire()
        expect(publish).not.toHaveBeenCalled()
        setRect({ left: 1, top: 2, width: 30, height: 40 })
        FakeResizeObserver.instances[0]!.fire()
        expect(publish).not.toHaveBeenCalled()
      })
    }
  }

  it('also drops an invalid placement measurement without changing its valid baseline', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    createPlacementAnchor(el, { visible: true, publish })
    publish.mockClear()
    setRect({ left: Number.NaN, top: 2, width: 30, height: 40 })
    FakeResizeObserver.instances[0]!.fire()
    setRect({ left: 1, top: 2, width: 30, height: 40 })
    FakeResizeObserver.instances[0]!.fire()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('geometry sentinel invalid-measure bounds', () => {
  it('stops after a bounded run of invalid geometry, without publishing it', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    const handle = createPlacementAnchor(el, {
      visible: true,
      followGeometry: true,
      publish,
    })
    publish.mockClear()
    handle.pulse()
    setRect({ left: Number.NaN, top: 2, width: 30, height: 40 })

    // The invalid path must have an independent upper bound. It is neither a
    // legitimate held-pointer pause nor the hidden transient follow path.
    for (let index = 0; index <= 30; index++) flushFrame()

    expect(publish).not.toHaveBeenCalled()
    expect(frames).toHaveLength(0)
  })

  it('keeps following when a short invalid measurement recovers', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    const handle = createPlacementAnchor(el, {
      visible: true,
      followGeometry: true,
      publish,
    })
    publish.mockClear()
    handle.pulse()
    setRect({ left: Number.POSITIVE_INFINITY, top: 2, width: 30, height: 40 })
    flushFrame()
    setRect({ left: 7, top: 2, width: 30, height: 40 })
    flushFrame()

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      visible: true,
      bounds: { x: 7, y: 2, width: 30, height: 40 },
    })
    expect(frames).toHaveLength(1)
  })

  it('gives a second pulse a fresh invalid budget after the first window naturally closes', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    const handle = createPlacementAnchor(el, {
      visible: true,
      followGeometry: true,
      publish,
    })
    publish.mockClear()
    setRect({ left: Number.NaN, top: 2, width: 30, height: 40 })
    handle.pulse()
    for (let index = 0; index <= 30; index++) flushFrame()
    expect(frames).toHaveLength(0)

    handle.pulse()
    flushFrame() // One invalid frame must not exhaust the fresh window.
    expect(frames).toHaveLength(1)
    setRect({ left: 8, top: 2, width: 30, height: 40 })
    flushFrame()
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      visible: true,
      bounds: { x: 8, y: 2, width: 30, height: 40 },
    })
  })

  it('keeps following 1000 valid moving frames and dispose drops the queued frame', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    const handle = createPlacementAnchor(el, {
      visible: true,
      followGeometry: true,
      publish,
    })
    publish.mockClear()
    handle.pulse()
    for (let index = 2; index <= 1_001; index++) {
      setRect({ left: index, top: 2, width: 30, height: 40 })
      flushFrame()
    }

    expect(publish).toHaveBeenCalledTimes(1_000)
    expect(frames).toHaveLength(1)
    handle.dispose()
    expect(frames).toHaveLength(0)
  })
})

describe('same-value event storms', () => {
  it('deduplicates 100k forward observer ticks without creating a RAF backlog', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Bounds) => void>()
    createViewAnchor(el, { present: true, publish })
    publish.mockClear()
    setRect({ left: 4, top: 2, width: 30, height: 40 })
    const observer = FakeResizeObserver.instances[0]!
    for (let index = 0; index < 100_000; index++) observer.fire()

    expect(publish).toHaveBeenCalledExactlyOnceWith({ x: 4, y: 2, width: 30, height: 40 })
    expect(frames).toHaveLength(0)
  })

  it('deduplicates 10k placement observer ticks without creating a RAF backlog', () => {
    const { el, setRect } = element()
    const publish = vi.fn<(value: Placement) => void>()
    createPlacementAnchor(el, { visible: true, publish })
    publish.mockClear()
    setRect({ left: 4, top: 2, width: 30, height: 40 })
    const observer = FakeResizeObserver.instances[0]!
    for (let index = 0; index < 10_000; index++) observer.fire()

    expect(publish).toHaveBeenCalledExactlyOnceWith({
      visible: true,
      bounds: { x: 4, y: 2, width: 30, height: 40 },
    })
    expect(frames).toHaveLength(0)
  })
})

// A transport must synchronously say whether it accepted the value. Promises
// belong in the transport's own queue/retry layer, not in the anchor callback.
const asyncPublisher = async (_value: Bounds): Promise<void> => {}
// @ts-expect-error asynchronous publishers are not accepted by the core API
const rejectedAsyncPublisher: Publisher<Bounds> = asyncPublisher
void rejectedAsyncPublisher
