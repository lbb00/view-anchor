import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createGeometryBatcher,
  createPlacementMessagePublisher,
  createSizeMessagePublisher,
} from '../src/protocol-publisher.js'
import type { GeometryBatch, GeometryMessage } from '../src/protocol.js'

const address = { anchorId: 'editor', generation: 7 }

let microtasks: Array<() => void> = []

beforeEach(() => {
  microtasks = []
  vi.stubGlobal('queueMicrotask', (callback: () => void) => microtasks.push(callback))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function flushMicrotasks(): void {
  const scheduled = microtasks
  microtasks = []
  scheduled.forEach((callback) => callback())
}

function placementMessage(
  overrides: Partial<Extract<GeometryMessage, { kind: 'placement' }>> = {},
): Extract<GeometryMessage, { kind: 'placement' }> {
  return {
    v: 1,
    kind: 'placement',
    anchorId: 'editor',
    generation: 7,
    seq: 1,
    placement: { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    ...overrides,
  }
}

describe('versioned message publishers', () => {
  it('adds address, version, kind, and strictly increasing sequence numbers', () => {
    const send = vi.fn<(message: GeometryMessage) => void>()
    const publish = createPlacementMessagePublisher(address, send)

    expect(publish({ visible: false })).toBe(true)
    expect(publish({ visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } })).toBe(true)
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      {
        v: 1,
        kind: 'placement',
        anchorId: 'editor',
        generation: 7,
        seq: 1,
        placement: { visible: false },
      },
      {
        v: 1,
        kind: 'placement',
        anchorId: 'editor',
        generation: 7,
        seq: 2,
        placement: { visible: true, bounds: { x: 1, y: 2, width: 3, height: 4 } },
      },
    ])
  })

  it('treats false as rejected, increments a failed attempt, and propagates throws', () => {
    const failure = new Error('transport down')
    const send = vi
      .fn<(message: GeometryMessage) => boolean | void>()
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockReturnValueOnce(true)
    const publish = createSizeMessagePublisher(address, send)

    expect(publish({ axis: 'block', extent: 20 })).toBe(false)
    expect(() => publish({ axis: 'block', extent: 21 })).toThrow(failure)
    expect(publish({ axis: 'inline', extent: 22 })).toBe(true)
    expect(send.mock.calls.map(([message]) => message.seq)).toEqual([1, 2, 3])
  })

  it('serializes only declared address fields into a stable wire envelope', () => {
    const placementSend = vi.fn<(message: GeometryMessage) => void>()
    const sizeSend = vi.fn<(message: GeometryMessage) => void>()
    const runtimeAddress = {
      generation: 7,
      debugToken: 'must-not-cross-the-wire',
      anchorId: 'editor',
    }

    const publishPlacement = createPlacementMessagePublisher(runtimeAddress, placementSend)
    publishPlacement({ visible: false })
    createSizeMessagePublisher(runtimeAddress, sizeSend)({ axis: 'block', extent: 20 })

    expect(Object.keys(placementSend.mock.calls[0]![0])).toEqual([
      'v',
      'kind',
      'anchorId',
      'generation',
      'seq',
      'placement',
    ])
    expect(Object.keys(sizeSend.mock.calls[0]![0])).toEqual([
      'v',
      'kind',
      'anchorId',
      'generation',
      'seq',
      'size',
    ])

    runtimeAddress.anchorId = 'renamed-editor'
    runtimeAddress.generation = 8
    publishPlacement({ visible: false })
    expect(placementSend.mock.calls[1]![0]).toMatchObject({
      anchorId: 'renamed-editor',
      generation: 8,
      seq: 2,
    })
  })
})

describe('createGeometryBatcher', () => {
  it('keeps only the latest generation/sequence per anchor and kind, while retaining distinct keys', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage({ seq: 1 }))
    batcher.publish(placementMessage({ seq: 2, placement: { visible: false } }))
    batcher.publish({
      v: 1,
      kind: 'size',
      anchorId: 'editor',
      generation: 8,
      seq: 1,
      size: { axis: 'block', extent: 30 },
    })
    batcher.publish(placementMessage({ generation: 8, seq: 1 }))
    batcher.publish(placementMessage({ generation: 7, seq: 99 }))

    flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      v: 1,
      kind: 'batch',
      messages: [
        placementMessage({ generation: 8, seq: 1 }),
        {
          v: 1,
          kind: 'size',
          anchorId: 'editor',
          generation: 8,
          seq: 1,
          size: { axis: 'block', extent: 30 },
        },
      ],
    })
  })

  it('schedules one microtask per task and never uses animation frames', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    const batcher = createGeometryBatcher(send)

    batcher.publish(placementMessage({ seq: 1 }))
    batcher.publish(placementMessage({ seq: 2 }))

    expect(microtasks).toHaveLength(1)
    expect(raf).not.toHaveBeenCalled()
  })

  it('remembers an accepted high-water mark and ignores late or duplicate frames', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage({ generation: 8, seq: 1 }))
    flushMicrotasks()

    expect(batcher.publish(placementMessage({ generation: 7, seq: 99 }))).toBe(true)
    expect(batcher.publish(placementMessage({ generation: 8, seq: 1 }))).toBe(true)
    expect(microtasks).toHaveLength(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('treats generation as anchor-wide and evicts older pending kinds', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    const oldSize: GeometryMessage = {
      v: 1,
      kind: 'size',
      anchorId: 'editor',
      generation: 7,
      seq: 9,
      size: { axis: 'block', extent: 20 },
    }

    batcher.publish(oldSize)
    batcher.publish(placementMessage({ generation: 8, seq: 1 }))
    flushMicrotasks()

    expect(send.mock.calls[0]![0].messages).toEqual([placementMessage({ generation: 8, seq: 1 })])
    expect(batcher.publish(oldSize)).toBe(true)
    expect(microtasks).toHaveLength(0)
  })

  it('clears one anchor or all anchors without disposing the batcher', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    const oldEditor = placementMessage({ generation: 8, seq: 1 })
    const sidebar = placementMessage({ anchorId: 'sidebar', generation: 4, seq: 1 })

    batcher.publish(oldEditor)
    batcher.publish(sidebar)
    batcher.clear('editor')
    flushMicrotasks()
    expect(send).toHaveBeenCalledWith({ v: 1, kind: 'batch', messages: [sidebar] })

    // Clearing the anchor also clears its generation floor.
    expect(batcher.publish(placementMessage({ generation: 1, seq: 1 }))).toBe(true)
    batcher.clear()
    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    expect(batcher.publish(placementMessage({ generation: 1, seq: 1 }))).toBe(true)
    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not restore a reentrantly superseded generation after the old snapshot is accepted', () => {
    const holder: { batcher?: ReturnType<typeof createGeometryBatcher> } = {}
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => {
      holder.batcher!.publish(
        placementMessage({ generation: 8, seq: 1, placement: { visible: false } }),
      )
    })
    const batcher = createGeometryBatcher(send)
    holder.batcher = batcher
    batcher.publish(placementMessage({ seq: 1 }))

    flushMicrotasks()
    expect(batcher.flush()).toBe(true)
    expect(
      send.mock.calls.map(([batch]) => [batch.messages[0]!.generation, batch.messages[0]!.seq]),
    ).toEqual([
      [7, 1],
      [8, 1],
    ])
  })

  it('does not let an in-flight frame contaminate a state cleared and recreated by send', () => {
    const holder: { batcher?: ReturnType<typeof createGeometryBatcher> } = {}
    let firstSend = true
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => {
      if (!firstSend) return true
      firstSend = false
      holder.batcher!.clear('editor')
      holder.batcher!.publish(
        placementMessage({ generation: 7, seq: 0, placement: { visible: false } }),
      )
      return true
    })
    const batcher = createGeometryBatcher(send)
    holder.batcher = batcher

    batcher.publish(placementMessage({ generation: 7, seq: 1 }))
    flushMicrotasks()
    flushMicrotasks()

    expect(batcher.publish(placementMessage({ generation: 7, seq: 1 }))).toBe(true)
    expect(microtasks).toHaveLength(1)
    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('rejects a nested flush and sends reentrant work in the following microtask', () => {
    const holder: { batcher?: ReturnType<typeof createGeometryBatcher> } = {}
    let nestedResult: boolean | undefined
    let firstSend = true
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => {
      if (!firstSend) return true
      firstSend = false
      holder.batcher!.publish(placementMessage({ seq: 2, placement: { visible: false } }))
      nestedResult = holder.batcher!.flush()
      return true
    })
    const batcher = createGeometryBatcher(send)
    holder.batcher = batcher

    batcher.publish(placementMessage({ seq: 1 }))
    flushMicrotasks()

    expect(nestedResult).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    flushMicrotasks()
    expect(send.mock.calls.map(([batch]) => batch.messages[0]!.seq)).toEqual([1, 2])
  })

  it('retains a rejected snapshot and retries it from the next publish', () => {
    const send = vi
      .fn<(batch: GeometryBatch) => boolean | void>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage())

    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)
    batcher.publish({
      v: 1,
      kind: 'size',
      anchorId: 'editor',
      generation: 7,
      seq: 1,
      size: { axis: 'block', extent: 20 },
    })
    flushMicrotasks()

    expect(send.mock.calls[1]![0].messages).toEqual([
      placementMessage(),
      {
        v: 1,
        kind: 'size',
        anchorId: 'editor',
        generation: 7,
        seq: 1,
        size: { axis: 'block', extent: 20 },
      },
    ])
  })

  it('turns asynchronous transport throws into onError and retains the snapshot', () => {
    const error = new Error('transport down')
    const onError = vi.fn()
    const send = vi
      .fn<(batch: GeometryBatch) => boolean | void>()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockReturnValueOnce(true)
    const batcher = createGeometryBatcher(send, { onError })
    batcher.publish(placementMessage())

    expect(() => flushMicrotasks()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error)
    expect(batcher.flush()).toBe(true)
  })

  it('turns an explicit flush throw into false when no error handler is supplied', () => {
    const error = new Error('transport down')
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => {
      throw error
    })
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage())

    expect(batcher.flush()).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reports an explicit flush throw to onError and returns false', () => {
    const error = new Error('transport down')
    const onError = vi.fn()
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => {
      throw error
    })
    const batcher = createGeometryBatcher(send, { onError })
    batcher.publish(placementMessage())

    expect(batcher.flush()).toBe(false)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('does not let an old failed generation overwrite a newer one', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>(() => false)
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage({ generation: 7, seq: 9 }))
    flushMicrotasks()
    batcher.publish(placementMessage({ generation: 8, seq: 1 }))
    flushMicrotasks()

    expect(send.mock.calls[1]![0].messages).toEqual([placementMessage({ generation: 8, seq: 1 })])
  })

  it('makes an already scheduled microtask inert after dispose', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    batcher.publish(placementMessage())
    batcher.dispose()

    flushMicrotasks()
    expect(send).not.toHaveBeenCalled()
    expect(batcher.publish(placementMessage())).toBe(false)
    expect(batcher.flush()).toBe(false)
  })

  it('handles 10k generation upgrades and per-anchor clears within the CPU budget', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    const count = 10_000
    const message = (anchorId: string, generation: number): GeometryMessage => ({
      v: 1,
      kind: 'placement',
      anchorId,
      generation,
      seq: 1,
      placement: { visible: false },
    })

    const startedAt = performance.now()
    for (let index = 0; index < count; index++) batcher.publish(message(`anchor-${index}`, 1))
    for (let index = 0; index < count; index++) batcher.publish(message(`anchor-${index}`, 2))
    for (let index = 0; index < count; index++) batcher.clear(`anchor-${index}`)

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(microtasks).toHaveLength(1)
    flushMicrotasks()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps only the final generation across 100k anchors', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)
    const count = 100_000
    const publish = (index: number, generation: number) =>
      batcher.publish({
        v: 1,
        kind: 'placement',
        anchorId: `anchor-${index}`,
        generation,
        seq: 1,
        placement: { visible: false },
      })

    for (let index = 0; index < count; index++) publish(index, 1)
    for (let index = 0; index < count; index++) publish(index, 2)
    flushMicrotasks()

    const messages = send.mock.calls[0]![0].messages
    expect(messages).toHaveLength(count)
    expect(messages.every((message) => message.generation === 2)).toBe(true)
  })

  it('flushes a late message without walking every anchor it has seen', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    // A flush must cost what the pending queue costs, not what the batcher has
    // ever seen: one lookup per pending message and no walk over the anchor
    // map. Counting the reads states that directly, which a wall-clock
    // comparison cannot do reliably at this scale.
    const mapReads = { get: 0, walks: 0 }
    class TrackedMap<K, V> extends Map<K, V> {
      override get(key: K) {
        mapReads.get++
        return super.get(key)
      }
      override values() {
        mapReads.walks++
        return super.values()
      }
      override keys() {
        mapReads.walks++
        return super.keys()
      }
      override entries() {
        mapReads.walks++
        return super.entries()
      }
      override forEach(
        callback: (value: V, key: K, map: Map<K, V>) => void,
        thisArg?: unknown,
      ): void {
        mapReads.walks++
        super.forEach(callback, thisArg)
      }
      override [Symbol.iterator]() {
        mapReads.walks++
        return super[Symbol.iterator]()
      }
    }

    const nativeMap = globalThis.Map
    // The batcher builds its anchor map at creation, so the substitution only
    // has to cover that one call.
    const batcher = ((): ReturnType<typeof createGeometryBatcher> => {
      globalThis.Map = TrackedMap as unknown as MapConstructor
      try {
        return createGeometryBatcher(send)
      } finally {
        globalThis.Map = nativeMap
      }
    })()

    for (let index = 0; index < 50; index++) {
      batcher.publish({
        v: 1,
        kind: 'placement',
        anchorId: `anchor-${index}`,
        generation: 1,
        seq: 1,
        placement: { visible: false },
      })
    }
    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    const lateSize: GeometryMessage = {
      v: 1,
      kind: 'size',
      anchorId: 'late',
      generation: 1,
      seq: 1,
      size: { axis: 'block', extent: 20 },
    }
    batcher.publish(lateSize)
    mapReads.get = 0
    mapReads.walks = 0

    expect(batcher.flush()).toBe(true)
    expect(send.mock.calls.at(-1)![0].messages).toEqual([lateSize])
    expect(mapReads).toEqual({ get: 1, walks: 0 })
  })
})

describe('publisher identity contract', () => {
  it('drops a recreated publisher’s first message at the same address (publishers must stay stable within a generation)', () => {
    const send = vi.fn<(batch: GeometryBatch) => boolean | void>()
    const batcher = createGeometryBatcher(send)

    const first = createPlacementMessagePublisher(address, batcher.publish)
    first({ visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } })
    flushMicrotasks()
    expect(send).toHaveBeenCalledTimes(1)

    // A new publisher for the same {anchorId, generation} restarts its own
    // `seq` at 1, but the batcher already recorded seq 1 as the high-water
    // mark, so the recreated publisher's first message is silently dropped.
    // Hold one publisher stable per generation (e.g. via useMemo/useRef in
    // React) and bump `generation` whenever a new publisher is needed.
    const second = createPlacementMessagePublisher(address, batcher.publish)
    expect(second({ visible: true, bounds: { x: 1, y: 1, width: 20, height: 20 } })).toBe(true)
    flushMicrotasks()

    expect(send).toHaveBeenCalledTimes(1)
  })
})
