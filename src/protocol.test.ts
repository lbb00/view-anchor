import { describe, expect, it } from 'vitest'
import type { PlacementMessage, SizeMessage } from './protocol.js'
import {
  GEOMETRY_PROTOCOL_VERSION,
  createGeometrySequenceGuard,
  decodeGeometryWireValue,
} from './protocol.js'

const placement = (overrides: Record<string, unknown> = {}): PlacementMessage => ({
  v: 1,
  kind: 'placement',
  anchorId: 'main-view',
  generation: 0,
  seq: 0,
  placement: { visible: true, bounds: { x: -10, y: 20, width: 30, height: 40 } },
  ...overrides,
} as PlacementMessage)

const size = (overrides: Record<string, unknown> = {}): SizeMessage => ({
  v: 1,
  kind: 'size',
  anchorId: 'main-view',
  generation: 0,
  seq: 0,
  size: { axis: 'block', extent: 40 },
  ...overrides,
} as SizeMessage)

function decode(value: unknown, maxMessages = 10) {
  return decodeGeometryWireValue(value, { maxMessages })
}

describe('decodeGeometryWireValue', () => {
  it('decodes valid placement and size messages without changing valid negative positions', () => {
    const placementResult = decode(placement())
    const sizeResult = decode(size())

    expect(placementResult).toEqual({ ok: true, value: placement() })
    expect(sizeResult).toEqual({ ok: true, value: size() })
    expect(GEOMETRY_PROTOCOL_VERSION).toBe(1)
  })

  it('decodes a hidden placement without bounds', () => {
    expect(decode(placement({ placement: { visible: false } }))).toEqual({
      ok: true,
      value: placement({ placement: { visible: false } }),
    })
  })

  it.each([
    null,
    [],
    { ...placement(), v: 2 },
    { ...placement(), kind: 'unknown' },
    { ...placement(), anchorId: '' },
    { ...placement(), generation: -1 },
    { ...placement(), generation: 0.5 },
    { ...placement(), generation: Number.NaN },
    { ...placement(), generation: Number.POSITIVE_INFINITY },
    { ...placement(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...placement(), seq: -1 },
    { ...placement(), seq: 0.5 },
    { ...placement(), seq: Number.NaN },
    { ...placement(), placement: { visible: true } },
    { ...placement(), placement: { visible: true, bounds: { x: 0, y: 0, width: -1, height: 1 } } },
    { ...placement(), placement: { visible: true, bounds: { x: 0.5, y: 0, width: 1, height: 1 } } },
    { ...placement(), placement: { visible: true, bounds: { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 } } },
    { ...size(), size: { axis: 'diagonal', extent: 1 } },
    { ...size(), size: { axis: 'inline', extent: -1 } },
    { ...size(), size: { axis: 'inline', extent: Number.NaN } },
    { ...size(), size: { axis: 'inline', extent: Number.MAX_SAFE_INTEGER + 1 } },
  ])('rejects malformed input: %#', (input) => {
    expect(decode(input).ok).toBe(false)
  })

  it('requires a caller-provided positive safe maximum for batches', () => {
    expect(decode({ v: 1, kind: 'batch', messages: [] }, 0).ok).toBe(false)
    expect(decode({ v: 1, kind: 'batch', messages: [] }, 0.5).ok).toBe(false)
    expect(decode({ v: 1, kind: 'batch', messages: [] }, Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it('decodes bounded batches and rejects oversize or invalid members', () => {
    const batch = { v: 1, kind: 'batch', messages: [placement(), size()] }
    expect(decode(batch, 2)).toEqual({ ok: true, value: batch })
    expect(decode(batch, 1).ok).toBe(false)
    expect(decode({ v: 1, kind: 'batch', messages: [placement(), { bad: true }] }).ok).toBe(false)
  })

  it('handles a 100k batch and rejects a malformed final member', () => {
    const messages = Array.from({ length: 100_000 }, (_, seq) => placement({ seq }))
    expect(decode({ v: 1, kind: 'batch', messages }, messages.length).ok).toBe(true)
    messages[messages.length - 1] = { bad: true } as unknown as PlacementMessage
    expect(decode({ v: 1, kind: 'batch', messages }, messages.length).ok).toBe(false)
    expect(decode({ v: 1, kind: 'batch', messages }, messages.length - 1).ok).toBe(false)
  })
})

describe('createGeometrySequenceGuard', () => {
  it('accepts newer sequence numbers, generation transitions, and rejects late or duplicate messages', () => {
    const guard = createGeometrySequenceGuard()
    expect(guard.accept(placement())).toBe(true)
    expect(guard.accept(placement())).toBe(false)
    expect(guard.accept(placement({ seq: 1 }))).toBe(true)
    expect(guard.accept(placement({ generation: 1, seq: 0 }))).toBe(true)
    expect(guard.accept(placement({ generation: 0, seq: 999 }))).toBe(false)
  })

  it('keeps distinct anchors and message kinds independent', () => {
    const guard = createGeometrySequenceGuard()
    expect(guard.accept(placement())).toBe(true)
    expect(guard.accept(size())).toBe(true)
    expect(guard.accept(placement({ anchorId: 'secondary' }))).toBe(true)
  })

  it('rejects an old generation across kinds after a newer generation is accepted', () => {
    const guard = createGeometrySequenceGuard()
    expect(guard.accept(size({ generation: 0, seq: 99 }))).toBe(true)
    expect(guard.accept(placement({ generation: 1 }))).toBe(true)
    expect(guard.accept(size({ generation: 0 }))).toBe(false)
    expect(guard.accept(size({ generation: 1 }))).toBe(true)
  })

  it('keeps both maximum sequence values and resets both kinds for a newer generation', () => {
    const guard = createGeometrySequenceGuard()
    const max = Number.MAX_SAFE_INTEGER
    expect(guard.accept(placement({ seq: max }))).toBe(true)
    expect(guard.accept(size({ seq: max }))).toBe(true)
    expect(guard.accept(size({ generation: 1, seq: 0 }))).toBe(true)
    expect(guard.accept(placement({ generation: 1, seq: 0 }))).toBe(true)
    expect(guard.accept(size({ generation: 1, seq: 0 }))).toBe(false)
    expect(guard.accept(placement({ generation: 1, seq: 0 }))).toBe(false)
    expect(guard.accept(placement({ generation: 0, seq: max }))).toBe(false)
  })

  it('forgets one anchor or every anchor when cleared', () => {
    const guard = createGeometrySequenceGuard()
    const first = placement()
    const second = placement({ anchorId: 'secondary' })
    guard.accept(first)
    guard.accept(second)
    guard.clear('main-view')
    expect(guard.accept(first)).toBe(true)
    expect(guard.accept(second)).toBe(false)
    guard.clear()
    expect(guard.accept(second)).toBe(true)
  })
})
