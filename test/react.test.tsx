import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { StrictMode, useCallback, useEffect, useRef } from 'react'
import { useViewAnchor, type UseViewAnchorOptions, type ViewAnchorRef } from '../src/react.js'
import type { Placement } from '../src/types.js'

// React 18 is the default install; the cleanup-replay suite below overrides
// the version the adapter sees to 19 so the ref-cleanup path is also covered.
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

// ── ResizeObserver stub ──────────────────────────────────────────────
// Behaviour is observed through the injected `publish` spy and FakeResizeObserver.
// The core publishes synchronously (no RAF defer), so a fired observer tick
// publishes immediately — nothing to flush.

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

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Assert an observer exists, then return it — so a missing observer
 *  surfaces as a clear assertion failure instead of a TypeError on `.fire()`. */
function firstObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances[0]!
}

function lastObserver(): FakeResizeObserver {
  expect(FakeResizeObserver.instances.length).toBeGreaterThanOrEqual(1)
  return FakeResizeObserver.instances.at(-1)!
}

// A real <div> rendered by React, with a stubbed getBoundingClientRect.
// Stubbing via a ref ensures the rect is deterministic in jsdom (which returns zeros).
function stubRect(el: HTMLElement, rect: { x: number; y: number; w: number; h: number }): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y + rect.h,
    width: rect.w,
    height: rect.h,
    toJSON: () => ({}),
  } as DOMRect)
}

// Test harness component: renders a <div> wired to useViewAnchor, and
// stubs its rect *before* the anchor measures it. We do the stubbing in a
// callback ref that runs before useViewAnchor's ref callback fires.
function Anchored(props: {
  options: UseViewAnchorOptions
  rect: { x: number; y: number; w: number; h: number }
  mounted?: boolean
}): React.JSX.Element | null {
  const { options, rect, mounted = true } = props
  const anchorRef = useViewAnchor(options)
  const elRef = useRef<HTMLDivElement | null>(null)
  const rectRef = useRef(rect)
  // Sync the latest rect post-commit; the stub is only read inside `setRef`
  // when React attaches a new element, which always happens after commit.
  useEffect(() => {
    rectRef.current = rect
  })

  // Stable ref prevents a rerender from tearing down + re-creating the anchor.
  // An unstable ref function would cause React to call ref(null)→ref(el) every
  // render, re-creating the anchor and double-publishing.
  const setRef = useCallback(
    (el: HTMLDivElement | null): void => {
      if (el && elRef.current !== el) {
        stubRect(el, rectRef.current)
      }
      elRef.current = el
      anchorRef(el)
    },
    [anchorRef],
  )

  if (!mounted) return null
  return <div ref={setRef} data-testid="anchored" />
}

describe('useViewAnchor: ref attach', () => {
  it('visible=true: publishes the element Placement once on mount', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored options={{ visible: true, publish }} rect={{ x: 11, y: 22, w: 333, h: 444 }} />,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 11, y: 22, width: 333, height: 444 },
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
  })

  it('visible=false: publishes { visible:false } on mount and does not observe', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored options={{ visible: false, publish }} rect={{ x: 11, y: 22, w: 333, h: 444 }} />,
      )
    })

    expect(publish).toHaveBeenCalledWith({ visible: false })
    expect(FakeResizeObserver.instances).toHaveLength(0)
  })
})

describe('useViewAnchor: ref null disposes', () => {
  it('detaching the DOM node publishes { visible:false } once, disconnects the observer, and stops publishing', async () => {
    const publish = vi.fn()

    function Host(props: { mounted: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ visible: true, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(<Host mounted={true} />))
    })
    expect(FakeResizeObserver.instances).toHaveLength(1)
    const ro = FakeResizeObserver.instances[0]!
    publish.mockClear()

    // Unmount just the inner div (ref → null) via a prop-driven rerender;
    // the hook stays alive, exercising the null-ref detach path.
    await act(async () => {
      rerender(<Host mounted={false} />)
      await Promise.resolve()
    })
    expect(ro.disconnected).toBe(true)

    // A vanished anchor must publish exactly one { visible:false } so the
    // host detaches the native view.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    publish.mockClear()

    // After the node is gone the anchor is inert.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })

  it('unmounting while visible becomes false in the same commit publishes one { visible:false }', async () => {
    const publish = vi.fn()

    function Host(props: { mounted: boolean; visible: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ visible: props.visible, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    const { rerender } = render(<Host mounted={true} visible={true} />)
    publish.mockClear()

    await act(async () => {
      rerender(<Host mounted={false} visible={false} />)
      await Promise.resolve()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
  })

  it('an unrelated rerender between collapse and detach does not re-collapse', async () => {
    const publish = vi.fn()

    function Host(props: { mounted: boolean; visible: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ visible: props.visible, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    const { rerender } = render(<Host mounted={true} visible={true} />)
    publish.mockClear()

    // visible flips to false: the deps-change effect applies the collapse.
    act(() => {
      rerender(<Host mounted={true} visible={false} />)
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    publish.mockClear()

    // A rerender with the exact same option values: `applied` is a new array
    // reference every render even though nothing changed, so this must not
    // be mistaken for a fresh, uncollapsed state.
    act(() => {
      rerender(<Host mounted={true} visible={false} />)
    })
    expect(publish).not.toHaveBeenCalled()

    // Unmounting now must not send the collapse a second time.
    await act(async () => {
      rerender(<Host mounted={false} visible={false} />)
      await Promise.resolve()
    })
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('useViewAnchor: opts/deps change', () => {
  it('visible change false → true re-publishes the current placement', () => {
    const publish = vi.fn()
    const { rerender } = render(
      <Anchored options={{ visible: false, publish }} rect={{ x: 3, y: 4, w: 60, h: 70 }} />,
    )
    publish.mockClear()

    act(() => {
      rerender(
        <Anchored options={{ visible: true, publish }} rect={{ x: 3, y: 4, w: 60, h: 70 }} />,
      )
    })

    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 3, y: 4, width: 60, height: 70 },
    })
  })

  it('deps change re-publishes even though visible/publish are unchanged', () => {
    const publish = vi.fn()
    const base = { visible: true, publish }
    const { rerender } = render(
      <Anchored options={{ ...base, deps: ['tab-a'] }} rect={{ x: 1, y: 1, w: 200, h: 200 }} />,
    )
    publish.mockClear()

    act(() => {
      rerender(
        <Anchored options={{ ...base, deps: ['tab-b'] }} rect={{ x: 1, y: 1, w: 200, h: 200 }} />,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 1, y: 1, width: 200, height: 200 },
    })
  })

  it('publish identity change routes the re-apply emit to the new callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <Anchored
        options={{ visible: true, publish: first }}
        rect={{ x: 0, y: 0, w: 100, h: 100 }}
      />,
    )
    first.mockClear()

    // A publish-identity change re-applies through the core's `update`, which
    // resets `lastPublished` and re-emits even on unchanged geometry.
    act(() => {
      rerender(
        <Anchored
          options={{ visible: true, publish: second }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
        />,
      )
    })

    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
    expect(first).not.toHaveBeenCalled()
  })
})

describe('useViewAnchor: unmount disposes', () => {
  it('unmounting the component publishes { visible:false } once, disconnects the observer, and never publishes after', async () => {
    const publish = vi.fn()
    const { unmount } = render(
      <Anchored options={{ visible: true, publish }} rect={{ x: 0, y: 0, w: 100, h: 100 }} />,
    )
    const ro = firstObserver()
    publish.mockClear()

    await act(async () => {
      unmount()
      await Promise.resolve()
    })

    expect(ro.disconnected).toBe(true)

    // Unmount publishes exactly one { visible:false }.
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    publish.mockClear()

    // After unmount the anchor is inert.
    ro.fire()
    window.dispatchEvent(new Event('resize'))
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('useViewAnchor: rejected hide', () => {
  const unmountAndFlush = async (unmount: () => void): Promise<void> => {
    await act(async () => {
      unmount()
      await Promise.resolve()
    })
  }

  it('sends { visible:false } again on unmount when the mount-time hide was rejected', async () => {
    const publish = vi.fn((p: Placement) => p.visible)
    const { unmount } = render(
      <Anchored options={{ visible: false, publish }} rect={{ x: 0, y: 0, w: 100, h: 100 }} />,
    )
    expect(publish).toHaveBeenCalledTimes(1)
    publish.mockClear()

    await unmountAndFlush(unmount)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
  })

  it('sends { visible:false } again on unmount when hiding through props was rejected', async () => {
    const publish = vi.fn((p: Placement) => p.visible)
    const rect = { x: 0, y: 0, w: 100, h: 100 }
    const { rerender, unmount } = render(
      <Anchored options={{ visible: true, publish }} rect={rect} />,
    )
    rerender(<Anchored options={{ visible: false, publish }} rect={rect} />)
    expect(publish).toHaveBeenLastCalledWith({ visible: false })
    publish.mockClear()

    await unmountAndFlush(unmount)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
  })

  it('does not repeat an accepted hide on unmount, even after an earlier rejection', async () => {
    const rejecting = vi.fn((p: Placement) => p.visible)
    const accepting = vi.fn()
    const rect = { x: 0, y: 0, w: 100, h: 100 }
    const { rerender, unmount } = render(
      <Anchored options={{ visible: false, publish: rejecting }} rect={rect} />,
    )
    // A new publish re-applies the hidden state and accepts it.
    rerender(<Anchored options={{ visible: false, publish: accepting }} rect={rect} />)
    expect(accepting).toHaveBeenCalledTimes(1)
    accepting.mockClear()

    await unmountAndFlush(unmount)

    expect(accepting).not.toHaveBeenCalled()
  })
})

describe('useViewAnchor: independent instances', () => {
  it('two anchors observe their own element and publish independently', () => {
    const publishA = vi.fn()
    const publishB = vi.fn()

    function Pair(): React.JSX.Element {
      return (
        <>
          <Anchored
            options={{ visible: true, publish: publishA }}
            rect={{ x: 0, y: 0, w: 10, h: 10 }}
          />
          <Anchored
            options={{ visible: true, publish: publishB }}
            rect={{ x: 100, y: 100, w: 20, h: 20 }}
          />
        </>
      )
    }

    act(() => {
      render(<Pair />)
    })

    expect(publishA).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    })
    expect(publishB).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 100, y: 100, width: 20, height: 20 },
    })
    expect(FakeResizeObserver.instances).toHaveLength(2)

    publishA.mockClear()
    publishB.mockClear()

    // Move A's element to a new rect, then fire only A's observer → only A
    // republishes; B is untouched.
    const aEl = FakeResizeObserver.instances[0]!.observed[0] as HTMLElement
    stubRect(aEl, { x: 1, y: 1, w: 30, h: 30 })
    FakeResizeObserver.instances[0]!.fire()
    expect(publishA).toHaveBeenCalledTimes(1)
    expect(publishA).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 1, y: 1, width: 30, height: 30 },
    })
    expect(publishB).not.toHaveBeenCalled()
  })
})

// ── Remount with visible transition ──────────────
// Production coupling: the debug cell is *unmounted* when hidden and *remounted*
// when shown, so the element's mount/unmount and `options.visible` flip together
// (visible=false ⟺ unmounted, visible=true ⟺ mounted). On "show", React commits
// the remounted element and fires the stable ref callback during the *commit*
// phase — before the `useEffect` that syncs `optsRef.current = opts` has run.
//
// When `optsRef.current` is synced in a post-commit effect instead of during
// render, the ref callback on remount reads a stale `optsRef.current.visible`
// (still `false`), calls `createViewAnchor(el, { visible:false })`, and emits
// a spurious `{ visible:false }`. Correct behaviour on show: publish the real
// Placement exactly once — no leading detach, no duplicate.

describe('useViewAnchor — remount with visible transition', () => {
  it('show (remount + visible false→true) publishes the real Placement once, no detach, not twice', () => {
    const publish = vi.fn()

    // Host drives BOTH `mounted` and the `visible` option from a single
    // `shown` flag, mirroring the production coupling (hidden ⟺ unmounted).
    function Host(props: { shown: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ visible: props.shown, publish }}
          rect={{ x: 17, y: 29, w: 321, h: 654 }}
          mounted={props.shown}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(<Host shown={true} />))
    })
    // Initial mount published once; clear before the show-transition assertions.
    publish.mockClear()

    // Hide: element unmounts AND visible flips to false.
    act(() => {
      rerender(<Host shown={false} />)
    })
    publish.mockClear()

    // Show: element remounts AND visible flips back to true. Must publish
    // the stubbed rect exactly once, no spurious detach, no duplicate.
    act(() => {
      rerender(<Host shown={true} />)
    })

    expect(publish).not.toHaveBeenCalledWith({ visible: false })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 17, y: 29, width: 321, height: 654 },
    })
  })
})

// ── StrictMode resilience ─────────────────────────────────────────────
// These lock the intended behaviour against React's StrictMode, which in dev
// double-fires every effect's setup/cleanup to surface unsafe lifecycle code.
// Invariant: after a real or StrictMode-simulated mount, exactly one live
// anchor has (a) published its Placement once, (b) still follows resizes, and
// (c) emits exactly one `{ visible:false }` when its element detaches.

describe('useViewAnchor — StrictMode resilience', () => {
  it('mount under StrictMode publishes the real Placement exactly once with one live observer', () => {
    // A non-idempotent setup would let StrictMode's attach→detach→re-attach
    // double-publish the mount Placement and leave two live observer connections.
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <Anchored options={{ visible: true, publish }} rect={{ x: 11, y: 22, w: 333, h: 444 }} />
        </StrictMode>,
      )
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 11, y: 22, width: 333, height: 444 },
    })
    // StrictMode may create extra observers during its throwaway pass, but
    // only one may remain connected.
    const live = FakeResizeObserver.instances.filter((o) => !o.disconnected)
    expect(live).toHaveLength(1)
  })

  it('after StrictMode mount settles, a resize still publishes once (anchor survived remount)', () => {
    // StrictMode's simulated unmount/remount must leave a working anchor.
    // If the surviving handle pointed at a disposed core or a stale observer,
    // the post-mount resize would publish zero times.
    const publish = vi.fn()
    act(() => {
      render(
        <StrictMode>
          <Anchored options={{ visible: true, publish }} rect={{ x: 5, y: 6, w: 70, h: 80 }} />
        </StrictMode>,
      )
    })
    publish.mockClear()

    // The live anchor is wired to the last observer created during mount.
    act(() => {
      const liveObserver = lastObserver()
      const liveEl = liveObserver.observed[0] as HTMLElement
      stubRect(liveEl, { x: 9, y: 9, w: 71, h: 81 })
      liveObserver.fire()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 9, y: 9, width: 71, height: 81 },
    })
  })

  it('detach under StrictMode publishes { visible:false } exactly once (contract 9 not amplified)', async () => {
    // StrictMode's extra detach/reattach must not multiply the single collapse.
    // A non-idempotent collapse path would emit the detach twice.
    const publish = vi.fn()

    function Host(props: { mounted: boolean }): React.JSX.Element {
      return (
        <Anchored
          options={{ visible: true, publish }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
          mounted={props.mounted}
        />
      )
    }

    let rerender!: (ui: React.ReactElement) => void
    act(() => {
      ;({ rerender } = render(
        <StrictMode>
          <Host mounted={true} />
        </StrictMode>,
      ))
    })
    publish.mockClear()

    // Detach just the inner <div> (ref → null) while the hook stays mounted.
    await act(async () => {
      rerender(
        <StrictMode>
          <Host mounted={false} />
        </StrictMode>,
      )
      await Promise.resolve()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
  })
})

// React 19 invokes the cleanup returned from a callback ref during its
// development replay, then attaches the same element again in the same turn.
// Publishing a detach during replay would visibly hide the native view;
// creating a second observer would leak work.
describe('useViewAnchor — callback-ref cleanup replay', () => {
  let installedVersion = ''
  beforeEach(() => {
    installedVersion = reactVersion.current
    reactVersion.current = '19.0.0'
  })
  afterEach(() => {
    reactVersion.current = installedVersion
  })

  it('coalesces same-turn cleanup → reattach, but collapses a real cleanup', async () => {
    const publish = vi.fn()
    let ref!: ViewAnchorRef

    function Capture(): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor({ visible: true, publish })
      return null
    }

    render(<Capture />)
    const el = document.createElement('div')
    stubRect(el, { x: 7, y: 8, w: 90, h: 100 })

    let cleanup!: () => void
    act(() => {
      const returned = ref(el)
      expect(returned).toEqual(expect.any(Function))
      cleanup = returned as () => void
    })
    const observer = firstObserver()
    publish.mockClear()

    act(() => {
      cleanup()
      ref(el)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(publish).not.toHaveBeenCalledWith({ visible: false })
    expect(publish).not.toHaveBeenCalled()
    expect(FakeResizeObserver.instances.filter((item) => !item.disconnected)).toEqual([observer])

    let realCleanup!: () => void
    act(() => {
      realCleanup = ref(el) as () => void
      realCleanup()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ visible: false })
    expect(observer.disconnected).toBe(true)
  })

  it('rethrows a real detach collapse failure after disposing its handle', () => {
    const failure = new Error('collapse failure')
    const publish = vi.fn((placement: Placement) => {
      if (!placement.visible) throw failure
    })
    let ref!: ViewAnchorRef

    function Capture(props: { revision: number }): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor({ visible: true, publish, deps: [props.revision] })
      return null
    }

    const { rerender } = render(<Capture revision={0} />)
    const el = document.createElement('div')
    stubRect(el, { x: 7, y: 8, w: 90, h: 100 })
    let cleanup!: () => void
    act(() => {
      cleanup = ref(el) as () => void
    })
    const observer = firstObserver()
    publish.mockClear()
    vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => callback())

    expect(() => cleanup()).toThrow(failure)
    expect(observer.disconnected).toBe(true)

    act(() => {
      rerender(<Capture revision={1} />)
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ visible: false })
  })

  it('replaces A with B without an intermediate detach after A cleanup', async () => {
    const publish = vi.fn()
    let ref!: ViewAnchorRef

    function Capture(): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor({ visible: true, publish })
      return null
    }

    const { unmount } = render(<Capture />)
    const first = document.createElement('div')
    const second = document.createElement('div')
    stubRect(first, { x: 1, y: 2, w: 30, h: 40 })
    stubRect(second, { x: 50, y: 60, w: 70, h: 80 })

    let firstCleanup!: () => void
    act(() => {
      firstCleanup = ref(first) as () => void
    })
    const observerA = firstObserver()
    publish.mockClear()

    act(() => {
      firstCleanup()
      ref(second)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 50, y: 60, width: 70, height: 80 },
    })
    expect(publish).not.toHaveBeenCalledWith({ visible: false })
    expect(observerA.disconnected).toBe(true)
    expect(lastObserver().disconnected).toBe(false)

    await act(async () => {
      unmount()
      await Promise.resolve()
    })
  })
})

describe('useViewAnchor — guard/scroll/geometry options', () => {
  it('creates the anchor, follows scroll, and re-applies deps', () => {
    const publish = vi.fn()
    let ref!: ReturnType<typeof useViewAnchor>

    function Capture(props: { options: UseViewAnchorOptions }): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor(props.options)
      return null
    }

    const options: UseViewAnchorOptions = {
      visible: true,
      publish,
      followScroll: true,
      followGeometry: false,
      deps: ['first'],
    }
    const { rerender } = render(<Capture options={options} />)
    const el = document.createElement('div')
    stubRect(el, { x: 3, y: 4, w: 50, h: 60 })
    act(() => {
      ref(el)
    })
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 3, y: 4, width: 50, height: 60 },
    })

    publish.mockClear()
    stubRect(el, { x: 9, y: 10, w: 70, h: 80 })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 9, y: 10, width: 70, height: 80 },
    })

    publish.mockClear()
    act(() => {
      rerender(<Capture options={{ ...options, deps: ['second'] }} />)
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 9, y: 10, width: 70, height: 80 },
    })
  })

  it('applies followScroll changes without requiring a manual deps entry', () => {
    const publish = vi.fn()
    let ref!: ReturnType<typeof useViewAnchor>

    function Capture(props: { options: UseViewAnchorOptions }): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor(props.options)
      return null
    }

    const base = { visible: true, publish, followScroll: false }
    const { rerender } = render(<Capture options={base} />)
    const el = document.createElement('div')
    stubRect(el, { x: 1, y: 2, w: 30, h: 40 })
    act(() => {
      ref(el)
    })
    publish.mockClear()

    act(() => {
      rerender(<Capture options={{ ...base, followScroll: true }} />)
    })
    stubRect(el, { x: 10, y: 20, w: 30, h: 40 })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      visible: true,
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    })
  })
})

describe('useViewAnchor: imperative frame following', () => {
  it('exposes pulse on the stable callback ref and tracks moves after a drag pause', async () => {
    const frames: Array<{ id: number; callback: FrameRequestCallback }> = []
    let nextFrameId = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.push({ id, callback })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const index = frames.findIndex((frame) => frame.id === id)
      if (index !== -1) frames.splice(index, 1)
    })
    const nextFrame = (): void => {
      frames.shift()?.callback(16)
    }

    const publish = vi.fn<(placement: Placement) => void>()
    let ref!: ViewAnchorRef
    function Capture(props: { followGeometry: boolean }): null {
      // oxlint-disable-next-line react/globals -- test-only callback ref capture
      ref = useViewAnchor({ visible: true, publish, followGeometry: props.followGeometry })
      return null
    }

    const { rerender } = render(<Capture followGeometry={true} />)
    const originalRef = ref
    const el = document.createElement('div')
    stubRect(el, { x: 0, y: 0, w: 100, h: 100 })
    ref.pulse()
    expect(frames).toHaveLength(0)
    act(() => {
      ref(el)
    })
    publish.mockClear()

    ref.pulse()
    nextFrame()
    nextFrame()
    expect(frames).toHaveLength(0)
    stubRect(el, { x: 50, y: 0, w: 100, h: 100 })
    ref.pulse()
    nextFrame()
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 50, y: 0, width: 100, height: 100 },
    })

    act(() => {
      rerender(<Capture followGeometry={false} />)
    })
    expect(ref).toBe(originalRef)
    frames.length = 0
    ref.pulse()
    expect(frames).toHaveLength(0)

    await act(async () => {
      ref(null)
      await Promise.resolve()
    })
    ref.pulse()
    expect(frames).toHaveLength(0)

    act(() => {
      rerender(<Capture followGeometry={true} />)
    })
    act(() => {
      ref(el)
    })
    stubRect(el, { x: 70, y: 0, w: 100, h: 100 })
    publish.mockClear()
    ref.pulse()
    nextFrame()
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 70, y: 0, width: 100, height: 100 },
    })
  })
})

describe('useViewAnchor: dedupe option', () => {
  it('omitting dedupe defaults to true: a same-rect tick is skipped', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored options={{ visible: true, publish }} rect={{ x: 0, y: 0, w: 100, h: 100 }} />,
      )
    })
    publish.mockClear()

    firstObserver().fire()

    expect(publish).not.toHaveBeenCalled()
  })

  it('dedupe: false publishes on every tick, even an unchanged rect', () => {
    const publish = vi.fn()
    act(() => {
      render(
        <Anchored
          options={{ visible: true, publish, dedupe: false }}
          rect={{ x: 0, y: 0, w: 100, h: 100 }}
        />,
      )
    })
    publish.mockClear()

    firstObserver().fire()
    firstObserver().fire()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith({
      visible: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    })
  })
})
