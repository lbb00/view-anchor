import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GEOMETRY_PROTOCOL_VERSION } from './protocol-types.js'
import { createGeometryBatcher } from './protocol-publisher.js'
import type {
  GeometryBatcher,
  GeometryBatchSend,
  GeometryBatcherOptions,
} from './protocol-publisher.js'

// ── onError contract during a reentrant dispose() ─────────────────────────
//
// GeometryBatcherOptions.onError must observe every batch-delivery error,
// including one raised by a send() that disposes the batcher before
// throwing. dispose() drops the instance's long-lived `options` reference
// (so a retained, disposed handle does not keep it reachable), so flush()
// must keep reporting to the options object that was live when it started,
// read dynamically at the moment of the error rather than cached ahead of
// send().

function sizeMessage(anchorId: string) {
  return {
    v: GEOMETRY_PROTOCOL_VERSION,
    kind: 'size' as const,
    anchorId,
    generation: 0,
    seq: 1,
    size: { axis: 'block' as const, extent: 1 },
  }
}

describe('createGeometryBatcher onError contract', () => {
  it('reports a send() error exactly once, with the original options object as `this`, even when send() reentrantly disposes first', () => {
    const thisArgs: unknown[] = []
    const errors: unknown[] = []
    const options: GeometryBatcherOptions = {
      onError(this: unknown, error: unknown) {
        thisArgs.push(this)
        errors.push(error)
      },
    }
    const failure = new Error('send failed')
    const send: GeometryBatchSend = () => {
      batcher.dispose()
      throw failure
    }
    const batcher: GeometryBatcher = createGeometryBatcher(send, options)
    batcher.publish(sizeMessage('a'))

    expect(batcher.flush()).toBe(false)
    expect(errors).toEqual([failure])
    expect(thisArgs).toEqual([options])
  })

  it('honors an onError reassignment made during send(), without dispose', () => {
    const original = vi.fn()
    const replacement = vi.fn()
    const options: GeometryBatcherOptions = { onError: original }
    const failure = new Error('send failed')
    const send: GeometryBatchSend = () => {
      options.onError = replacement
      throw failure
    }
    const batcher = createGeometryBatcher(send, options)
    batcher.publish(sizeMessage('a'))

    expect(batcher.flush()).toBe(false)
    expect(original).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledWith(failure)
  })

  it('does not read onError on the successful delivery path', () => {
    let read = false
    const options: GeometryBatcherOptions = {}
    Object.defineProperty(options, 'onError', {
      configurable: true,
      get() {
        read = true
        return undefined
      },
      set() {},
    })
    const send: GeometryBatchSend = () => true
    const batcher = createGeometryBatcher(send, options)
    batcher.publish(sizeMessage('a'))

    expect(batcher.flush()).toBe(true)
    expect(read).toBe(false)
  })
})

// ── Retained-handle memory audit ──────────────────────────────────────────
//
// A caller that keeps a disposed handle around (e.g. stored in a ref for
// later reuse) must not keep the anchor's target element, publish/send
// callback, or last-published payload reachable through it. Each factory
// closes over these as plain `let` bindings, so `dispose()` must actively
// drop them — merely flipping a `disposed` flag leaves the closures (and
// whatever they captured) reachable for the handle's lifetime.
//
// This runs the actual source through rolldown in a fresh `node --expose-gc`
// process (a jsdom/vitest process is not itself GC-inspectable) and asserts
// via WeakRef that everything but the handle becomes collectible.

// Vitest's import.meta.url is not a plain file:// URL, so anchor on the
// working directory the `test` script always runs from (repo root).
const repoRoot = process.cwd()
const rolldownHref = import.meta.resolve('rolldown')

const CHILD_SCRIPT = `
import { resolve } from 'node:path'
const { rolldown } = await import(${JSON.stringify(rolldownHref)})

async function load(entry) {
  const bundle = await rolldown({ input: resolve(${JSON.stringify(repoRoot)}, entry) })
  try {
    const { output } = await bundle.generate({ format: 'esm' })
    const code = output[0].code
    return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  } finally {
    await bundle.close()
  }
}

const core = await load('src/view-anchor.ts')
const size = await load('src/size-advertiser.ts')
const protocol = await load('src/protocol.ts')
const measureLoop = await load('src/measure-loop.ts')

class FakeResizeObserver {
  static instances = []
  constructor(cb) {
    this.cb = cb
    FakeResizeObserver.instances.push(this)
  }
  observe() {}
  disconnect() {}
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.ResizeObserver = FakeResizeObserver

// Stored rather than fired immediately, so measure-loop cases can drive
// frame() deterministically instead of racing a real animation frame.
let pendingRaf = null
globalThis.requestAnimationFrame = (cb) => {
  pendingRaf = cb
  return 1
}
globalThis.cancelAnimationFrame = () => {
  pendingRaf = null
}
function runPendingRaf() {
  const cb = pendingRaf
  pendingRaf = null
  if (cb) cb(0)
}

function bigPayload() {
  return { data: new Array(200_000).fill(7) }
}

function movingTarget() {
  let call = 0
  return {
    ownerDocument: {},
    getBoundingClientRect() {
      call++
      return { left: call, top: call, width: 10 + call, height: 10 + call }
    },
  }
}

const retainedHandles = []
const refs = []

// ── basic: dispose right after construction, no reentrancy ───────────────
function basicCase(name) {
  const payload = bigPayload()
  const payloadRef = new WeakRef(payload)
  const target = movingTarget()
  const targetRef = new WeakRef(target)
  const publish = () => (payload.data.length > 0)
  const handle =
    name === 'view'
      ? core.createViewAnchor(target, { present: true, publish })
      : name === 'placement'
        ? core.createPlacementAnchor(target, { visible: true, publish })
        : size.createSizeAdvertiser(target, { axis: 'block', publish })
  handle.dispose()
  retainedHandles.push(handle)
  refs.push({ name: name + '-basic-payload', ref: payloadRef })
  refs.push({ name: name + '-basic-target', ref: targetRef })
}

// ── resurrection: a second publish tick reentrantly disposes and then
//    either declines (returns false) or throws. publishCandidate's rollback
//    must not resurrect the previously accepted value once dispose() has
//    already cleared it. ──
function resurrectionCase(name, mode) {
  FakeResizeObserver.instances = []
  const target = movingTarget()
  const targetRef = new WeakRef(target)
  let callCount = 0
  let capturedFirst = null
  const publish = (candidate) => {
    callCount++
    if (callCount === 1) {
      capturedFirst = candidate
      return true
    }
    handle.dispose()
    if (mode === 'throw') throw new Error('publish failure')
    return false
  }
  const handle =
    name === 'view'
      ? core.createViewAnchor(target, { present: true, publish })
      : core.createPlacementAnchor(target, { visible: true, publish })
  const firstRef = new WeakRef(capturedFirst)
  capturedFirst = null
  const observer = FakeResizeObserver.instances[0]
  try {
    observer.cb([], observer)
  } catch {
    // Expected: the second publish() intentionally throws after disposing.
  }
  retainedHandles.push(handle)
  refs.push({ name: name + '-resurrection-' + mode + '-first-published', ref: firstRef })
  refs.push({ name: name + '-resurrection-' + mode + '-target', ref: targetRef })
}

// ── batcher: no target; covers send and onError closures separately ──────
function batcherCase() {
  const sendPayload = bigPayload()
  const sendPayloadRef = new WeakRef(sendPayload)
  const errorPayload = bigPayload()
  const errorPayloadRef = new WeakRef(errorPayload)
  const send = () => (sendPayload.data.length > 0)
  const onError = () => {
    void errorPayload
  }
  const handle = protocol.createGeometryBatcher(send, { onError })
  handle.dispose()
  retainedHandles.push(handle)
  refs.push({ name: 'batcher-send-payload', ref: sendPayloadRef })
  refs.push({ name: 'batcher-onError-payload', ref: errorPayloadRef })
}

// ── batcher: an error reported during a reentrant dispose() must not keep
//    the reported-on payload reachable once reporting has finished. ──────
function f1BigObjectCase() {
  const errorPayload = bigPayload()
  const errorPayloadRef = new WeakRef(errorPayload)
  let batcher
  const send = () => {
    batcher.dispose()
    throw new Error('f1 send failure')
  }
  const onError = () => {
    void errorPayload
  }
  batcher = protocol.createGeometryBatcher(send, { onError })
  batcher.publish({
    v: protocol.GEOMETRY_PROTOCOL_VERSION,
    kind: 'size',
    anchorId: 'f1',
    generation: 0,
    seq: 1,
    size: { axis: 'block', extent: 1 },
  })
  batcher.flush()
  retainedHandles.push(batcher)
  refs.push({ name: 'f1-error-payload-after-report', ref: errorPayloadRef })
}

// ── size advertiser: a ResizeObserver callback queued before disconnect()
//    can still fire once more; it must not resurrect \`latest\`. ──────────
function sizeLateCallbackCase() {
  FakeResizeObserver.instances = []
  const firstBox = { blockSize: 10, inlineSize: 20 }
  const firstBoxRef = new WeakRef(firstBox)
  const secondBox = { blockSize: 30, inlineSize: 40 }
  const secondBoxRef = new WeakRef(secondBox)
  const target = movingTarget()
  const publish = () => true
  const handle = size.createSizeAdvertiser(target, { axis: 'block', publish })
  const observer = FakeResizeObserver.instances[0]
  const lateCallback = observer.cb
  lateCallback([{ borderBoxSize: [firstBox] }], observer)
  handle.dispose()
  lateCallback([{ borderBoxSize: [secondBox] }], observer)
  retainedHandles.push(handle)
  retainedHandles.push(lateCallback)
  refs.push({ name: 'size-late-callback-first-box', ref: firstBoxRef })
  refs.push({ name: 'size-late-callback-second-box', ref: secondBoxRef })
}

// ── measure-loop: objects closed over by produce/same/sink must not
//    outlive dispose(), even without any reentrancy. ─────────────────────
function measureLoopCaptureCase() {
  const producePayload = bigPayload()
  const producePayloadRef = new WeakRef(producePayload)
  const samePayload = bigPayload()
  const samePayloadRef = new WeakRef(samePayload)
  const sinkPayload = bigPayload()
  const sinkPayloadRef = new WeakRef(sinkPayload)
  const produce = () => {
    void producePayload
    return null
  }
  const same = () => {
    void samePayload
    return false
  }
  const sink = () => {
    void sinkPayload
    return true
  }
  const loop = measureLoop.createMeasureLoop({ produce, same, sink })
  loop.dispose()
  retainedHandles.push(loop)
  refs.push({ name: 'measure-loop-capture-produce-payload', ref: producePayloadRef })
  refs.push({ name: 'measure-loop-capture-same-payload', ref: samePayloadRef })
  refs.push({ name: 'measure-loop-capture-sink-payload', ref: sinkPayloadRef })
}

// ── measure-loop: produce() disposing synchronously must stop frame()'s
//    subsequent deliver() call from writing \`last\`. ─────────────────────
function measureLoopProduceDisposeCase() {
  const bigObject = bigPayload()
  const bigRef = new WeakRef(bigObject)
  let loop
  const produce = () => {
    loop.dispose()
    return bigObject
  }
  const same = () => false
  const sink = () => true
  loop = measureLoop.createMeasureLoop({ produce, same, sink })
  loop.setActive(true)
  loop.schedule()
  runPendingRaf()
  retainedHandles.push(loop)
  refs.push({ name: 'measure-loop-produce-dispose-value', ref: bigRef })
}

// ── measure-loop: same() disposing synchronously must stop frame()'s
//    subsequent deliver() call from writing \`last\`. ─────────────────────
function measureLoopSameDisposeCase() {
  const primer = { tag: 'primer' }
  const bigObject = bigPayload()
  const bigRef = new WeakRef(bigObject)
  let loop
  let produceCall = 0
  const produce = () => {
    produceCall++
    return produceCall === 1 ? primer : bigObject
  }
  const same = () => {
    loop.dispose()
    return false
  }
  const sink = () => true
  loop = measureLoop.createMeasureLoop({ produce, same, sink })
  loop.setActive(true)
  loop.schedule()
  runPendingRaf() // delivers \`primer\`, sets last = primer
  loop.schedule()
  runPendingRaf() // produce() returns bigObject; same() reentrantly disposes
  retainedHandles.push(loop)
  refs.push({ name: 'measure-loop-same-dispose-value', ref: bigRef })
}

// ── measure-loop: sink() reentrantly disposing and then rejecting must not
//    resurrect the previously delivered value into \`last\`. ─────────────
function measureLoopSinkRejectDisposeCase() {
  const primer = bigPayload()
  const primerRef = new WeakRef(primer)
  const nextValue = { tag: 'next-reject' }
  let loop
  let produceCall = 0
  const produce = () => {
    produceCall++
    return produceCall === 1 ? primer : nextValue
  }
  const same = () => false
  const sink = (value) => {
    if (value === primer) return true
    loop.dispose()
    return false
  }
  loop = measureLoop.createMeasureLoop({ produce, same, sink })
  loop.setActive(true)
  loop.schedule()
  runPendingRaf()
  loop.schedule()
  runPendingRaf()
  retainedHandles.push(loop)
  refs.push({ name: 'measure-loop-sink-reject-previous-value', ref: primerRef })
}

// ── measure-loop: sink() reentrantly disposing and then throwing must not
//    resurrect the previously delivered value into \`last\`. ─────────────
function measureLoopSinkThrowDisposeCase() {
  const primer = bigPayload()
  const primerRef = new WeakRef(primer)
  const nextValue = { tag: 'next-throw' }
  let loop
  let produceCall = 0
  const produce = () => {
    produceCall++
    return produceCall === 1 ? primer : nextValue
  }
  const same = () => false
  const sink = (value) => {
    if (value === primer) return true
    loop.dispose()
    throw new Error('sink failure')
  }
  loop = measureLoop.createMeasureLoop({ produce, same, sink })
  loop.setActive(true)
  loop.schedule()
  runPendingRaf()
  loop.schedule()
  try {
    runPendingRaf()
  } catch {
    // Expected: sink() intentionally throws after disposing.
  }
  retainedHandles.push(loop)
  refs.push({ name: 'measure-loop-sink-throw-previous-value', ref: primerRef })
}

basicCase('view')
basicCase('placement')
basicCase('size')
resurrectionCase('view', 'reject')
resurrectionCase('placement', 'reject')
resurrectionCase('view', 'throw')
resurrectionCase('placement', 'throw')
batcherCase()
f1BigObjectCase()
sizeLateCallbackCase()
measureLoopCaptureCase()
measureLoopProduceDisposeCase()
measureLoopSameDisposeCase()
measureLoopSinkRejectDisposeCase()
measureLoopSinkThrowDisposeCase()

async function collect() {
  for (let round = 0; round < 3; round++) {
    await new Promise(setImmediate)
    globalThis.gc()
  }
}

await collect()

console.log(
  JSON.stringify({
    retainedHandleCount: retainedHandles.length,
    result: refs.map(({ name, ref }) => ({ name, retained: ref.deref() !== undefined })),
  }),
)
`

interface AuditResult {
  retainedHandleCount: number
  result: { name: string; retained: boolean }[]
}

function runAudit(): AuditResult {
  mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(repoRoot, '.tmp', 'gc-'))
  const scriptPath = join(dir, 'audit.js')
  writeFileSync(scriptPath, CHILD_SCRIPT)
  try {
    const stdout = execFileSync(process.execPath, ['--expose-gc', scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 25_000,
    })
    const lastLine = stdout.trim().split('\n').at(-1)
    if (!lastLine) throw new Error(`audit produced no output:\n${stdout}`)
    return JSON.parse(lastLine) as AuditResult
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('disposed handle retention (real GC, separate process)', () => {
  it('drops target, publish/send, onError, and last-published references once dispose() runs, even with the handle (and, where relevant, a late callback) retained', () => {
    const audit = runAudit()
    // 15 scenarios; sizeLateCallbackCase retains both the handle and a late
    // callback reference, so the handle count is one higher than the case count.
    expect(audit.retainedHandleCount).toBe(16)
    expect(audit.result).toHaveLength(26)
    const retained = audit.result.filter((r) => r.retained).map((r) => r.name)
    expect(retained).toEqual([])
  }, 30_000)
})
