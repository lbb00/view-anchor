import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGeometryBatcher } from '../src/protocol-publisher.js'
import { createSizeAdvertiser } from '../src/size-advertiser.js'
import { createPlacementAnchor, createViewAnchor } from '../src/view-anchor.js'

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(_target: Element): void {}

  disconnect(): void {
    this.disconnected = true
  }

  fireSize(blockSize: number): void {
    this.callback(
      [{ borderBoxSize: [{ blockSize, inlineSize: 0 }] }] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    )
  }
}

let frames: Array<() => void> = []

beforeEach(() => {
  FakeResizeObserver.instances = []
  frames = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('requestAnimationFrame', ((callback: () => void) => {
    frames.push(callback)
    return frames.length
  }) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function target(): HTMLElement {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 1,
    top: 2,
    width: 30,
    height: 40,
  } as DOMRect)
  return element
}

describe('AbortSignal lifecycle', () => {
  it('does not publish or start work when the signal is already aborted', () => {
    const controller = new AbortController()
    controller.abort()
    const publish = vi.fn()

    createViewAnchor(target(), { present: true, publish, signal: controller.signal })
    createPlacementAnchor(target(), { visible: true, publish, signal: controller.signal })
    createSizeAdvertiser(target(), { axis: 'block', publish, signal: controller.signal })
    const batcher = createGeometryBatcher(publish, { signal: controller.signal })

    expect(publish).not.toHaveBeenCalled()
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(
      batcher.publish({
        v: 1,
        kind: 'placement',
        anchorId: 'panel',
        generation: 1,
        seq: 1,
        placement: { visible: false },
      }),
    ).toBe(false)
  })

  it('uses the same cleanup path when the signal aborts', async () => {
    const controller = new AbortController()
    const viewPublish = vi.fn()
    const placementPublish = vi.fn()
    const sizePublish = vi.fn()
    const batchSend = vi.fn()

    const view = createViewAnchor(target(), {
      present: true,
      publish: viewPublish,
      signal: controller.signal,
    })
    const placement = createPlacementAnchor(target(), {
      visible: true,
      publish: placementPublish,
      signal: controller.signal,
    })
    createSizeAdvertiser(target(), {
      axis: 'block',
      publish: sizePublish,
      signal: controller.signal,
    })
    const batcher = createGeometryBatcher(batchSend, { signal: controller.signal })
    const sizeObserver = FakeResizeObserver.instances.at(-1)!
    sizeObserver.fireSize(80)
    batcher.publish({
      v: 1,
      kind: 'placement',
      anchorId: 'panel',
      generation: 1,
      seq: 1,
      placement: { visible: false },
    })

    viewPublish.mockClear()
    placementPublish.mockClear()
    controller.abort()
    FakeResizeObserver.instances.forEach((observer) => expect(observer.disconnected).toBe(true))
    frames.forEach((frame) => frame())
    await Promise.resolve()

    expect(viewPublish).not.toHaveBeenCalled()
    expect(placementPublish).not.toHaveBeenCalled()
    expect(sizePublish).not.toHaveBeenCalled()
    expect(batchSend).not.toHaveBeenCalled()

    view.dispose()
    placement.dispose()
  })
})
