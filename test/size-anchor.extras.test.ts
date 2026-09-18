import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createSizeAnchor } from '../src/size-anchor.js'
import type { SizeMeasurement } from '../src/types.js'

// ── Extras: clipped/degenerate RO shapes, multi-instance isolation, and
//    update() re-publish behaviour ──────────────────────────────────────
//
// Same stub style as `size-anchor.test.ts`. `fireRaw(entry)` posts an
// arbitrary entry verbatim to exercise the
// `borderBoxSize?.[0] ?? contentBoxSize?.[0] ?? latest` fallback chain
// (the base `fire(block, inline)` always fills both box arrays).

interface RoSize {
  blockSize: number
  inlineSize: number
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
  /** Fire one standards-shaped entry (both boxes filled) for the target. */
  fire(blockSize: number, inlineSize: number): void {
    const target = this.observed[0] ?? document.createElement('div')
    this.cb(
      [
        {
          borderBoxSize: [{ blockSize, inlineSize }],
          contentBoxSize: [{ blockSize, inlineSize }],
          target,
        },
      ] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    )
  }
  /** Post an arbitrary, possibly-degenerate entry verbatim (no box defaults).
   *  `target` defaults to the observed element when the caller omits it. */
  fireRaw(entry: { borderBoxSize?: RoSize[]; contentBoxSize?: RoSize[]; target?: Element }): void {
    const target = entry.target ?? this.observed[0] ?? document.createElement('div')
    this.cb(
      [{ ...entry, target } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
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

function obs(i = 0): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThan(i)
  return FakeResizeObserver.instances[i]!
}

function el(): HTMLElement {
  return document.createElement('div')
}

describe('createSizeAnchor: update() re-publishes current value', () => {
  it('emits the current size to the new sink immediately, without a fresh RO tick', () => {
    const first = vi.fn<(s: SizeMeasurement) => void>()
    const second = vi.fn<(s: SizeMeasurement) => void>()
    const handle = createSizeAnchor(el(), { axis: 'block', publish: first })

    obs().fire(120, 0)
    flushRafs()
    expect(first).toHaveBeenCalledWith({ axis: 'block', extent: 120 })

    // No fire() between swap and assertion — the value must arrive on update().
    handle.update({ publish: second })
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
  })

  it('re-publishes a measured zero instead of treating it as no value', () => {
    const first = vi.fn<(s: SizeMeasurement) => void>()
    const second = vi.fn<(s: SizeMeasurement) => void>()
    const handle = createSizeAnchor(el(), { axis: 'block', publish: first })

    obs().fire(0, 0)
    flushRafs()
    handle.update({ publish: second })

    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 0 })
  })
})

describe('createSizeAnchor: update() before any size', () => {
  it('does not call the new sink when no RO frame has produced a size yet', () => {
    const first = vi.fn<(s: SizeMeasurement) => void>()
    const second = vi.fn<(s: SizeMeasurement) => void>()
    const handle = createSizeAnchor(el(), { axis: 'block', publish: first })

    // latest is still null — produce() returns null.
    handle.update({ publish: second })
    expect(second).not.toHaveBeenCalled()
  })
})

describe('createSizeAnchor: content-box fallback', () => {
  it('uses contentBoxSize when borderBoxSize is absent', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    createSizeAnchor(el(), { axis: 'block', publish })

    obs().fireRaw({ contentBoxSize: [{ blockSize: 88, inlineSize: 0 }] })
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 88 })
  })
})

describe('createSizeAnchor: empty box arrays', () => {
  it('an empty-array entry publishes nothing yet does not break a later real frame', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    createSizeAnchor(el(), { axis: 'block', publish })

    obs().fireRaw({ borderBoxSize: [], contentBoxSize: [] })
    flushRafs()
    expect(publish).not.toHaveBeenCalled()

    obs().fire(90, 0)
    flushRafs()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 90 })
  })
})

describe('createSizeAnchor: zero extent', () => {
  it('publishes extent 0 (content collapsed) rather than dropping the frame', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    createSizeAnchor(el(), { axis: 'block', publish })

    obs().fire(0, 0)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 0 })
  })
})

describe('createSizeAnchor: independent instances', () => {
  it('each size anchor owns its own sink and dedupe baseline', () => {
    const publishA = vi.fn<(s: SizeMeasurement) => void>()
    const publishB = vi.fn<(s: SizeMeasurement) => void>()
    createSizeAnchor(el(), { axis: 'block', publish: publishA })
    createSizeAnchor(el(), { axis: 'block', publish: publishB })

    // instances[0] drives A only.
    obs(0).fire(120, 0)
    flushRafs()
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishA).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
    expect(publishB).not.toHaveBeenCalled()

    // instances[1] drives B only — same extent A already used must still emit
    // (independent baselines, not a shared dedupe).
    obs(1).fire(120, 0)
    flushRafs()
    expect(publishB).toHaveBeenCalledTimes(1)
    expect(publishB).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
    expect(publishA).toHaveBeenCalledTimes(1)
  })
})

describe('createSizeAnchor: baseline resets per instance', () => {
  it('a new size anchor publishes its first frame even if it equals a disposed one', () => {
    const publishA = vi.fn<(s: SizeMeasurement) => void>()
    const handleA = createSizeAnchor(el(), { axis: 'block', publish: publishA })
    obs(0).fire(120, 0)
    flushRafs()
    handleA.dispose()

    const publishB = vi.fn<(s: SizeMeasurement) => void>()
    createSizeAnchor(el(), { axis: 'block', publish: publishB })
    obs(1).fire(120, 0)
    flushRafs()

    expect(publishB).toHaveBeenCalledTimes(1)
    expect(publishB).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
  })
})

describe('createSizeAnchor: body/html guard', () => {
  it('warns once when target is document.body and not for a normal element', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const publish = vi.fn<(s: SizeMeasurement) => void>()

    createSizeAnchor(document.body, { axis: 'block', publish })
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockClear()
    createSizeAnchor(el(), { axis: 'block', publish })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createSizeAnchor: idempotent dispose', () => {
  it('a second dispose() is a no-op (no throw, no extra disconnect)', () => {
    const publish = vi.fn<(s: SizeMeasurement) => void>()
    const handle = createSizeAnchor(el(), { axis: 'block', publish })

    handle.dispose()
    expect(() => handle.dispose()).not.toThrow()
    // disconnect ran exactly once: the observer is nulled after the first.
    expect(obs().disconnected).toBe(true)
  })
})
