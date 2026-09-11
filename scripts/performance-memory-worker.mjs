const [protocolUrl, scenario, countText] = process.argv.slice(2)
const count = Number(countText)

if (typeof globalThis.gc !== 'function' || !protocolUrl || !Number.isSafeInteger(count)) {
  throw new Error('invalid isolated memory benchmark invocation')
}

const { createGeometryBatcher, createGeometrySequenceGuard } = await import(protocolUrl)

const message = (index) => ({
  v: 1,
  kind: 'placement',
  anchorId: `anchor-${index}`,
  generation: 1,
  seq: 1,
  placement: { visible: false },
})

globalThis.queueMicrotask = () => {}
globalThis.gc()
const baseline = process.memoryUsage()

function memoryDelta() {
  const current = process.memoryUsage()
  return {
    heapDeltaBytes: current.heapUsed - baseline.heapUsed,
    rssDeltaBytes: current.rss - baseline.rss,
  }
}

if (scenario === 'batcher') {
  const batcher = createGeometryBatcher(() => true)
  for (let index = 0; index < count; index++) batcher.publish(message(index))
  globalThis.gc()
  const pending = memoryDelta()
  batcher.flush()
  globalThis.gc()
  const retainedAfterFlush = memoryDelta()
  batcher.clear()
  globalThis.gc()
  const afterClear = memoryDelta()
  process.stdout.write(JSON.stringify({
    pending,
    retainedAfterFlush,
    afterClear,
  }))
} else if (scenario === 'guard') {
  const guard = createGeometrySequenceGuard()
  for (let index = 0; index < count; index++) guard.accept(message(index))
  globalThis.gc()
  const retained = memoryDelta()
  guard.clear()
  globalThis.gc()
  const afterClear = memoryDelta()
  process.stdout.write(JSON.stringify({
    sequenceGuard: { retained, afterClear },
  }))
} else {
  throw new Error(`unknown memory benchmark scenario: ${scenario}`)
}
