import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { StrictMode, useCallback, useRef } from 'react'
import { useSizeAnchor, type UseSizeAnchorOptions, type SizeAnchorRef } from '../src/react.js'

const reactVersion = vi.hoisted(() => ({ current: '' }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  reactVersion.current = actual.version
  return {
    ...actual,
    get version() {
      return reactVersion.current
    },
  }
})

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
  fire(blockSize: number, inlineSize: number): void {
    const target = this.observed[0] ?? document.createElement('div')
    const entry = {
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

beforeEach(() => {
  FakeResizeObserver.instances = []
  rafQueue = []
  rafIdCounter = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', fakeRaf as unknown as typeof window.requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) => {
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

function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

function lastObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances.at(-1)!
}

function SizeAnchored(props: {
  options: UseSizeAnchorOptions
  mounted?: boolean
}): React.JSX.Element | null {
  const { options, mounted = true } = props
  const anchorRef = useSizeAnchor(options)
  const elRef = useRef<HTMLDivElement | null>(null)

  const setRef = useCallback(
    (el: HTMLDivElement | null): void => {
      elRef.current = el
      anchorRef(el)
    },
    [anchorRef],
  )

  if (!mounted) return null
  return <div ref={setRef} data-testid="size-anchored" />
}

describe('useSizeAnchor: ref attach', () => {
  it('publishes the element size once the first RO frame arrives', () => {
    const publish = vi.fn()
    act(() => {
      render(<SizeAnchored options={{ axis: 'block', publish }} />)
    })

    expect(FakeResizeObserver.instances).toHaveLength(1)
    expect(publish).not.toHaveBeenCalled()

    firstObserver().fire(200, 100)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 200 })
  })

  it('axis:inline reads inlineSize from the border-box entry', () => {
    const publish = vi.fn()
    act(() => {
      render(<SizeAnchored options={{ axis: 'inline', publish }} />)
    })

    firstObserver().fire(100, 321)
    flushRafs()

    expect(publish).toHaveBeenCalledWith({ axis: 'inline', extent: 321 })
  })
})

describe('useSizeAnchor: ref null disposes', () => {
  it('detaching the DOM node disconnects the observer and stops publishing', async () => {
    const publish = vi.fn()

    function Host(props: { mounted: boolean }): React.JSX.Element {
      return <SizeAnchored options={{ axis: 'block', publish }} mounted={props.mounted} />
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(<Host mounted={true} />))
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    const ro = FakeResizeObserver.instances[0]!

    firstObserver().fire(100, 50)
    flushRafs()
    publish.mockClear()

    await act(async () => {
      rerender(<Host mounted={false} />)
      await Promise.resolve()
    })

    expect(ro.disconnected).toBe(true)

    ro.fire(200, 100)
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('useSizeAnchor: opts/deps change', () => {
  it('publish identity change routes subsequent emits to the new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<SizeAnchored options={{ axis: 'block', publish: first }} />)

    firstObserver().fire(100, 50)
    flushRafs()
    expect(first).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
    first.mockClear()

    act(() => {
      rerender(<SizeAnchored options={{ axis: 'block', publish: second }} />)
    })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
    expect(first).not.toHaveBeenCalled()

    second.mockClear()
    firstObserver().fire(150, 75)
    flushRafs()

    expect(second).toHaveBeenCalledWith({ axis: 'block', extent: 150 })
    expect(first).not.toHaveBeenCalled()
  })

  it('deps change re-publishes even though axis/publish are unchanged', () => {
    const publish = vi.fn()
    const base = { axis: 'block' as const, publish }
    const { rerender } = render(<SizeAnchored options={{ ...base, deps: ['tab-a'] }} />)

    firstObserver().fire(100, 50)
    flushRafs()
    publish.mockClear()

    act(() => {
      rerender(<SizeAnchored options={{ ...base, deps: ['tab-b'] }} />)
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ axis: 'block', extent: 100 })
  })
})

describe('useSizeAnchor: unmount disposes', () => {
  it('unmounting the component disconnects the observer and never publishes after', async () => {
    const publish = vi.fn()
    const { unmount } = render(<SizeAnchored options={{ axis: 'block', publish }} />)
    const ro = firstObserver()

    firstObserver().fire(100, 50)
    flushRafs()
    publish.mockClear()

    await act(async () => {
      unmount()
      await Promise.resolve()
    })

    expect(ro.disconnected).toBe(true)

    ro.fire(200, 100)
    flushRafs()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('useSizeAnchor: independent instances', () => {
  it('two size anchors observe their own element and publish independently', () => {
    const publishA = vi.fn()
    const publishB = vi.fn()

    function Pair(): React.JSX.Element {
      return (
        <>
          <SizeAnchored options={{ axis: 'block', publish: publishA }} />
          <SizeAnchored options={{ axis: 'inline', publish: publishB }} />
        </>
      )
    }

    act(() => {
      render(<Pair />)
    })

    expect(FakeResizeObserver.instances).toHaveLength(2)

    FakeResizeObserver.instances[0]!.fire(120, 80)
    flushRafs()
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishA).toHaveBeenCalledWith({ axis: 'block', extent: 120 })
    expect(publishB).not.toHaveBeenCalled()

    FakeResizeObserver.instances[1]!.fire(90, 200)
    flushRafs()
    expect(publishB).toHaveBeenCalledTimes(1)
    expect(publishB).toHaveBeenCalledWith({ axis: 'inline', extent: 200 })
    expect(publishA).toHaveBeenCalledTimes(1)
  })
})

describe('useSizeAnchor — StrictMode resilience', () => {
  it('mount under StrictMode starts observing with one live observer', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <SizeAnchored options={{ axis: 'block', publish }} />
        </StrictMode>,
      )
    })

    const live = FakeResizeObserver.instances.filter((o) => !o.disconnected)
    expect(live).toHaveLength(1)
  })

  it('after StrictMode mount settles, a resize still publishes once (anchor survived remount)', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <SizeAnchored options={{ axis: 'block', publish }} />
        </StrictMode>,
      )
    })
    publish.mockClear()

    const liveObserver = lastObserver()
    liveObserver.fire(150, 100)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 150 })
  })
})

describe('useSizeAnchor — callback-ref cleanup replay (React 19)', () => {
  let installedVersion = ''
  beforeEach(() => {
    installedVersion = reactVersion.current
    reactVersion.current = '19.0.0'
  })
  afterEach(() => {
    reactVersion.current = installedVersion
  })

  it('coalesces same-turn cleanup → reattach, but disconnects on a real cleanup', async () => {
    const publish = vi.fn()
    let ref!: SizeAnchorRef

    function Capture(): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useSizeAnchor({ axis: 'block', publish })
      return null
    }

    render(<Capture />)
    const el = document.createElement('div')

    let cleanup!: () => void
    act(() => {
      const returned = ref(el)
      expect(returned).toEqual(expect.any(Function))
      cleanup = returned as () => void
    })
    const observer = firstObserver()

    act(() => {
      cleanup()
      ref(el)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(FakeResizeObserver.instances.filter((item) => !item.disconnected)).toEqual([observer])

    let realCleanup!: () => void
    act(() => {
      realCleanup = ref(el) as () => void
      realCleanup()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(observer.disconnected).toBe(true)
  })
})

describe('useSizeAnchor: axis change recreates handle', () => {
  it('changing axis from block to inline disposes and recreates the handle, publishing inline extent', () => {
    const publish = vi.fn()
    const { rerender } = render(<SizeAnchored options={{ axis: 'block', publish }} />)

    firstObserver().fire(100, 200)
    flushRafs()
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
    publish.mockClear()

    // Change axis from block to inline - should dispose and recreate
    act(() => {
      rerender(<SizeAnchored options={{ axis: 'inline', publish }} />)
    })

    // New observer should be created (old one disconnected)
    const live = FakeResizeObserver.instances.filter((o) => !o.disconnected)
    expect(live).toHaveLength(1)
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true)

    // Fire on the new observer
    FakeResizeObserver.instances[1]!.fire(100, 200)
    flushRafs()

    // Should publish with inline axis now
    expect(publish).toHaveBeenCalledWith({ axis: 'inline', extent: 200 })
  })
})

describe('useSizeAnchor: dedupe option', () => {
  it('omitting dedupe defaults to true: a same-extent tick is skipped', () => {
    const publish = vi.fn()
    act(() => {
      render(<SizeAnchored options={{ axis: 'block', publish }} />)
    })

    firstObserver().fire(100, 50)
    flushRafs()
    publish.mockClear()

    firstObserver().fire(100, 50)
    flushRafs()

    expect(publish).not.toHaveBeenCalled()
  })

  it('dedupe: false publishes on every tick, even an unchanged extent', () => {
    const publish = vi.fn()
    act(() => {
      render(<SizeAnchored options={{ axis: 'block', publish, dedupe: false }} />)
    })

    firstObserver().fire(100, 50)
    flushRafs()
    publish.mockClear()

    firstObserver().fire(100, 50)
    flushRafs()
    firstObserver().fire(100, 50)
    flushRafs()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith({ axis: 'block', extent: 100 })
  })
})
