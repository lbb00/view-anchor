import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { act, startTransition, Suspense, useState } from 'react'
import { useViewAnchor } from '../src/react.js'
import type { Placement } from '../src/types.js'

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const never = new Promise<never>(() => {})

function Anchored({
  publish,
  suspend,
}: {
  publish: (p: Placement) => void
  suspend: boolean
}): React.JSX.Element {
  const ref = useViewAnchor({ visible: true, publish })
  if (suspend) throw never
  return <div ref={ref} />
}

describe('useViewAnchor under concurrent rendering', () => {
  it('collapses through the committed publish when a newer render never commits', async () => {
    const committed = vi.fn<(p: Placement) => void>()
    const abandoned = vi.fn<(p: Placement) => void>()
    let switchToAbandoned!: () => void
    function App(): React.JSX.Element {
      const [next, setNext] = useState(false)
      // oxlint-disable-next-line react/globals -- test-only state setter capture
      switchToAbandoned = () => setNext(true)
      return (
        <Suspense fallback={null}>
          <Anchored publish={next ? abandoned : committed} suspend={next} />
        </Suspense>
      )
    }

    const view = render(<App />)
    expect(committed).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }))

    // A transition that suspends keeps the committed tree on screen, so this
    // render's options never commit.
    await act(async () => {
      startTransition(switchToAbandoned)
    })

    view.unmount()
    await act(async () => {})

    expect(committed).toHaveBeenLastCalledWith({ visible: false })
    expect(abandoned).not.toHaveBeenCalled()
  })

  it('mounts without a callback-ref warning on the installed React version', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(<Anchored publish={() => {}} suspend={false} />)
    view.unmount()
    await act(async () => {})
    const messages = errors.mock.calls.map((args) => String(args[0]))
    expect(messages.filter((m) => m.includes('callback ref'))).toEqual([])
  })
})
