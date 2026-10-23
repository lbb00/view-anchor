import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Hot-path JIT regression. Each scenario is a fresh process so placement/size
// switching does not pollute the feedback of a stable call. Counts are
// invocation counts, not time budgets: V8 13.6 waits 15000 calls before
// TurboFan, and the steady sequence guard needs about two million calls
// because each call is too small to exhaust the tier-up budget sooner.
// A failure means a hot function never reached the required tier, or V8
// deoptimized code that belongs to the bundled library. Functions called
// directly from this harness sometimes stay on Maglev because V8 inlines
// them; those accept either optimizing tier. TurboFan is required for the
// callees that compile their own code. Harness deopts are ignored. This does
// not measure browser layout time.
const hotCalls = 200_000
const guardCalls = 2_000_000
const batchCalls = 40_000
const batchSize = 8
const bundleNames = new Set(['protocol.js', 'core.js', 'size.js'])
const tierRank = { MAGLEV: 1, TURBOFAN_JS: 2 }

const optPattern =
  /\[completed (?:optimizing|compiling) [^\n]*?<JSFunction (?:(?<name>[^ <]+) )?<file:\/\/(?<file>\/[^>]+)> \(sfi = [^)]+\)> \(target (?<tier>MAGLEV|TURBOFAN_JS)\)/g
const deoptPattern =
  /\[bailout \(kind: [^,]+, reason: (?<reason>.*?)\): begin\. deoptimizing 0x[0-9a-f]+ <JSFunction (?:(?<name>[^ <]+) )?<file:\/\/(?<file>\/[^>]+)>/g

function fileName(filePath) {
  const slash = filePath.lastIndexOf('/')
  return decodeURIComponent(slash === -1 ? filePath : filePath.slice(slash + 1))
}

function displayName(name) {
  return name === '' ? '(anonymous)' : name
}

function parseTrace(text) {
  const tiers = new Map()
  const deopts = []
  for (const match of text.matchAll(optPattern)) {
    const key = `${fileName(match.groups.file)}\0${match.groups.name ?? ''}`
    const tier = match.groups.tier
    const previous = tiers.get(key)
    if (!previous || tierRank[tier] > tierRank[previous]) tiers.set(key, tier)
  }
  for (const match of text.matchAll(deoptPattern)) {
    deopts.push({
      file: fileName(match.groups.file),
      name: match.groups.name ?? '',
      reason: match.groups.reason,
    })
  }
  return { tiers, deopts }
}

function tierAtLeast(parsed, file, name, minimum) {
  const tier = parsed.tiers.get(`${file}\0${name}`)
  return tier !== undefined && tierRank[tier] >= tierRank[minimum]
}

function bundleDeopts(parsed) {
  return parsed.deopts.filter((item) => bundleNames.has(item.file))
}

function assertParser() {
  const parsed = parseTrace(
    [
      '[completed optimizing 0x1 <JSFunction flush <file:///tmp/protocol.js> (sfi = 0x2)> (target TURBOFAN_JS)]',
      '[completed compiling 0x1 <JSFunction publishFrame <file:///tmp/size.js> (sfi = 0x2)> (target MAGLEV) - took 0.000, 0.200, 0.000 ms]',
      '[completed optimizing 0x1 <JSFunction <file:///tmp/protocol.js> (sfi = 0x2)> (target TURBOFAN_JS)]',
      '[bailout (kind: deopt-eager, reason: wrong map): begin. deoptimizing 0x1 <JSFunction readX <file:///tmp/jit-self-test.mjs> (sfi = 0x2)>, 0x3 <Code MAGLEV>, opt id 1]',
    ].join('\n'),
  )
  if (parsed.tiers.get('protocol.js\0flush') !== 'TURBOFAN_JS') {
    throw new Error('JIT trace parser missed a TurboFan completion')
  }
  if (parsed.tiers.get('size.js\0publishFrame') !== 'MAGLEV') {
    throw new Error('JIT trace parser missed a Maglev completion')
  }
  if (parsed.tiers.get('protocol.js\0') !== 'TURBOFAN_JS') {
    throw new Error('JIT trace parser missed an anonymous optimized function')
  }
  if (
    parsed.deopts.length !== 1 ||
    parsed.deopts[0].name !== 'readX' ||
    parsed.deopts[0].reason !== 'wrong map' ||
    parsed.deopts[0].file !== 'jit-self-test.mjs'
  ) {
    throw new Error('JIT trace parser missed a wrong-map deopt')
  }
  const ignored = bundleDeopts(parsed)
  if (ignored.length !== 0) throw new Error('self-test deopt was treated as library code')
  const caught = bundleDeopts({
    deopts: [{ file: 'protocol.js', name: 'accept', reason: 'wrong map' }],
  })
  if (caught.length !== 1) throw new Error('a hot-path deopt would be ignored')
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Tiny functions can finish their first loop before Maglev is installed.
// Pause, then repeat the same call shape so TurboFan is queued. Batcher
// scenarios pass `false`: their queued microtask changes publish's branch.
async function heat(count, body, again = true) {
  for (let index = 0; index < count; index++) body(index)
  if (!again) return count
  await pause(100)
  const extra = Math.min(20_000, count)
  for (let index = count; index < count + extra; index++) body(index)
  return count + extra
}

function placementMessage(anchorId, seq, generation = 1, visible = true) {
  return {
    v: 1,
    kind: 'placement',
    anchorId,
    generation,
    seq,
    placement: visible
      ? { visible: true, bounds: { x: seq, y: -seq, width: 100, height: 50 } }
      : { visible: false },
  }
}

function sizeMessage(anchorId, seq, generation = 1) {
  return {
    v: 1,
    kind: 'size',
    anchorId,
    generation,
    seq,
    size: { axis: 'block', extent: seq },
  }
}

function installDom() {
  const queue = []
  let nextFrame = 1
  let resizeCallback
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resizeCallback = callback
    }
    observe() {
      return undefined
    }
    disconnect() {
      return undefined
    }
  }
  globalThis.IntersectionObserver = class {
    observe() {
      return undefined
    }
    disconnect() {
      return undefined
    }
  }
  globalThis.window = {
    addEventListener() {
      return undefined
    },
    removeEventListener() {
      return undefined
    },
    document: { body: {}, documentElement: {} },
  }
  globalThis.requestAnimationFrame = (callback) => {
    queue.push(callback)
    return nextFrame++
  }
  globalThis.cancelAnimationFrame = () => undefined
  return {
    drainFrame() {
      const callback = queue.shift()
      if (callback) callback(performance.now())
      return callback !== undefined
    },
    resize(entries) {
      if (!resizeCallback) throw new Error('ResizeObserver callback was not installed')
      resizeCallback(entries)
    },
  }
}

function element(rect) {
  return {
    ownerDocument: window.document,
    parentElement: null,
    parentNode: null,
    getBoundingClientRect() {
      return rect
    },
  }
}

const protocolFile = 'protocol.js'
const coreFile = 'core.js'
const sizeFile = 'size.js'

const scenarios = [
  {
    name: 'decode-visible-batch',
    turbofan: [
      [protocolFile, 'decodeGeometryWireValue'],
      [protocolFile, 'decodeMessage'],
      [protocolFile, 'decodePlacement'],
    ],
    async run({ protocol }) {
      const messages = Array.from({ length: batchSize }, (_, index) =>
        placementMessage('a', index + 1),
      )
      const batch = { v: 1, kind: 'batch', messages }
      let sink = 0
      const total = await heat(batchCalls, () => {
        const result = protocol.decodeGeometryWireValue(batch, { maxMessages: messages.length })
        if (!result.ok) throw new Error(result.error)
        sink += result.value.messages.length
      })
      if (sink !== total * batchSize) throw new Error(`decode sink ${sink}`)
    },
  },
  {
    name: 'decode-union-batch',
    turbofan: [
      [protocolFile, 'decodeGeometryWireValue'],
      [protocolFile, 'decodeMessage'],
      [protocolFile, 'decodePlacement'],
      [protocolFile, 'decodeSize'],
    ],
    async run({ protocol }) {
      const messages = Array.from({ length: batchSize }, (_, index) =>
        index % 2 === 0 ? placementMessage('a', index + 1) : sizeMessage('a', index + 1),
      )
      const batch = { v: 1, kind: 'batch', messages }
      let sink = 0
      const total = await heat(batchCalls, () => {
        const result = protocol.decodeGeometryWireValue(batch, { maxMessages: messages.length })
        if (!result.ok) throw new Error(result.error)
        sink += result.value.messages.length
      })
      if (sink !== total * batchSize) throw new Error(`union decode sink ${sink}`)
    },
  },
  {
    name: 'decode-invalid-tail',
    turbofan: [
      [protocolFile, 'decodeGeometryWireValue'],
      [protocolFile, 'decodeMessage'],
      [protocolFile, 'decodePlacement'],
    ],
    async run({ protocol }) {
      const messages = [
        ...Array.from({ length: batchSize - 1 }, (_, index) => placementMessage('a', index + 1)),
        { bad: true },
      ]
      const batch = { v: 1, kind: 'batch', messages }
      let sink = 0
      const total = await heat(batchCalls, () => {
        const result = protocol.decodeGeometryWireValue(batch, { maxMessages: messages.length })
        if (result.ok) throw new Error('invalid batch was accepted')
        sink += 1
      })
      if (sink !== total) throw new Error(`invalid decode sink ${sink}`)
    },
  },
  {
    name: 'decode-visible-toggle',
    turbofan: [
      [protocolFile, 'decodeMessage'],
      [protocolFile, 'decodePlacement'],
    ],
    optimized: [[protocolFile, 'decodeGeometryWireValue']],
    async run({ protocol }) {
      const shown = placementMessage('a', 1, 1, true)
      const hidden = placementMessage('a', 1, 1, false)
      let sink = 0
      const total = await heat(hotCalls, (index) => {
        const result = protocol.decodeGeometryWireValue(index % 2 === 0 ? shown : hidden, {
          maxMessages: 8,
        })
        if (!result.ok) throw new Error(result.error)
        sink += result.value.seq
      })
      if (sink !== total) throw new Error(`toggle sink ${sink}`)
    },
  },
  {
    name: 'guard-steady',
    turbofan: [[protocolFile, 'accept']],
    async run({ protocol }) {
      const guard = protocol.createGeometrySequenceGuard()
      const message = placementMessage('steady', 0)
      await heat(guardCalls, (index) => {
        const seq = index + 1
        message.seq = seq
        if (!guard.accept(message)) throw new Error(`steady accept rejected seq ${seq}`)
      })
      if (guard.accept(message)) throw new Error('duplicate accept succeeded')
    },
  },
  {
    name: 'guard-union',
    turbofan: [[protocolFile, 'accept']],
    async run({ protocol }) {
      const guard = protocol.createGeometrySequenceGuard()
      await heat(hotCalls, (index) => {
        const seq = index + 1
        const message = seq % 2 === 0 ? placementMessage('steady', seq) : sizeMessage('steady', seq)
        if (!guard.accept(message)) throw new Error(`union accept rejected seq ${seq}`)
      })
    },
  },
  {
    name: 'batcher-steady',
    turbofan: [
      [protocolFile, 'publish'],
      [protocolFile, 'flush'],
    ],
    async run({ protocol }) {
      let sink = 0
      const batcher = protocol.createGeometryBatcher((batch) => {
        sink += batch.messages.length
        return true
      })
      const total = await heat(
        hotCalls,
        (index) => {
          const seq = index + 1
          if (!batcher.publish(placementMessage('steady', seq))) throw new Error('publish rejected')
          if (!batcher.flush()) throw new Error('flush rejected')
        },
        false,
      )
      if (sink !== total) throw new Error(`batcher sink ${sink}`)
    },
  },
  {
    name: 'batcher-union',
    turbofan: [
      [protocolFile, 'publish'],
      [protocolFile, 'flush'],
    ],
    async run({ protocol }) {
      let sink = 0
      const batcher = protocol.createGeometryBatcher((batch) => {
        sink += batch.messages.length
        return true
      })
      const total = await heat(
        hotCalls,
        (index) => {
          const seq = index + 1
          const message =
            seq % 2 === 0 ? placementMessage('steady', seq) : sizeMessage('steady', seq)
          if (!batcher.publish(message)) throw new Error('publish rejected')
          if (!batcher.flush()) throw new Error('flush rejected')
        },
        false,
      )
      if (sink !== total) throw new Error(`union batcher sink ${sink}`)
    },
  },
  {
    // The publisher closure is anonymous. It is small enough to stay on
    // Maglev or be inlined into the harness, so either optimizing tier counts.
    name: 'publisher-visible',
    optimized: [[protocolFile, '']],
    async run({ protocol }) {
      let seq = 0
      let sink = 0
      const publish = protocol.createPlacementMessagePublisher(
        { anchorId: 'publisher', generation: 1 },
        (message) => {
          seq = message.seq
          sink += message.placement.bounds.width
        },
      )
      const total = await heat(hotCalls, (index) => {
        if (!publish({ visible: true, bounds: { x: index, y: -1, width: 10, height: 8 } })) {
          throw new Error('publisher rejected')
        }
      })
      if (seq !== total || sink !== total * 10) throw new Error(`publisher seq ${seq}`)
    },
  },
  {
    name: 'measure',
    turbofan: [[coreFile, 'clampRect']],
    optimized: [[coreFile, 'measurePlacement']],
    async run({ core }) {
      const target = {
        getBoundingClientRect() {
          return { left: -1.25, top: 2.75, width: 100.5, height: 50.25 }
        },
      }
      let sink = 0
      const total = await heat(hotCalls, () => {
        sink += core.measurePlacement(target).bounds.width
      })
      if (sink !== total * 101) throw new Error(`measure sink ${sink}`)
    },
  },
  {
    name: 'remeasure-stable',
    turbofan: [
      [coreFile, 'measureTarget'],
      [coreFile, 'samePlacement'],
      [coreFile, 'clampRect'],
    ],
    optimized: [[coreFile, 'measureAndPublish']],
    async run({ core }) {
      installDom()
      const rect = { left: 10, top: 2.2, width: 20.4, height: 8.6 }
      let published = 0
      const handle = core.createViewAnchor(element(rect), {
        visible: true,
        dedupe: true,
        publish() {
          published += 1
        },
      })
      await heat(hotCalls, () => handle.remeasure())
      if (published !== 1) throw new Error(`stable remeasure published ${published}`)
    },
  },
  {
    name: 'remeasure-moving',
    turbofan: [
      [coreFile, 'measureTarget'],
      [coreFile, 'clampRect'],
    ],
    optimized: [[coreFile, 'measureAndPublish']],
    async run({ core }) {
      installDom()
      const rect = { left: 10, top: 2.2, width: 20.4, height: 8.6 }
      let published = 0
      const handle = core.createViewAnchor(element(rect), {
        visible: true,
        dedupe: true,
        publish() {
          published += 1
        },
      })
      const total = await heat(hotCalls, (index) => {
        rect.left = index
        handle.remeasure()
      })
      if (published !== total + 1) throw new Error(`moving remeasure published ${published}`)
    },
  },
  {
    name: 'follow-moving',
    turbofan: [
      [coreFile, 'followFrame'],
      [coreFile, 'measureTarget'],
      [coreFile, 'samePlacement'],
    ],
    async run({ core }) {
      const dom = installDom()
      const rect = { left: 10, top: 2.2, width: 20.4, height: 8.6 }
      let armed = false
      const target = element(rect)
      target.getBoundingClientRect = () => {
        if (armed) rect.left += 1
        return rect
      }
      let published = 0
      const handle = core.createViewAnchor(target, {
        visible: true,
        dedupe: true,
        followGeometry: true,
        publish() {
          published += 1
        },
      })
      armed = true
      handle.pulse(60_000_000)
      const total = await heat(hotCalls, () => {
        if (!dom.drainFrame()) throw new Error('follow frame was not scheduled')
      })
      if (published !== total + 1) throw new Error(`follow published ${published}`)
    },
  },
  {
    // onResize is often inlined into the caller, so it may have no compile of
    // its own. A deopt there still fails the library-deopt check.
    name: 'size-stable',
    optimized: [
      [sizeFile, 'publishFrame'],
      [sizeFile, 'measure'],
    ],
    async run({ size }) {
      const dom = installDom()
      let published = 0
      size.createSizeAnchor(element({}), {
        axis: 'block',
        dedupe: true,
        publish() {
          published += 1
        },
      })
      await heat(hotCalls, () => {
        dom.resize([
          {
            borderBoxSize: [{ blockSize: 40.4, inlineSize: 3 }],
            contentBoxSize: [{ blockSize: 40.4, inlineSize: 3 }],
          },
        ])
        if (!dom.drainFrame()) throw new Error('size frame was not scheduled')
      })
      if (published !== 1) throw new Error(`stable size published ${published}`)
    },
  },
  {
    name: 'size-moving',
    optimized: [
      [sizeFile, 'publishFrame'],
      [sizeFile, 'measure'],
      [sizeFile, 'publishExtent'],
    ],
    async run({ size }) {
      const dom = installDom()
      let published = 0
      size.createSizeAnchor(element({}), {
        axis: 'block',
        dedupe: true,
        publish(measurement) {
          published += 1
          return measurement.extent
        },
      })
      const total = await heat(hotCalls, (index) => {
        const extent = index + 1
        dom.resize([
          {
            borderBoxSize: [{ blockSize: extent + 0.4, inlineSize: 3 }],
            contentBoxSize: [{ blockSize: extent + 0.4, inlineSize: 3 }],
          },
        ])
        if (!dom.drainFrame()) throw new Error('size frame was not scheduled')
      })
      if (published !== total) throw new Error(`moving size published ${published}`)
    },
  },
]

function traceChild(scriptArgs) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const result = spawnSync(
    process.execPath,
    [
      '--trace-opt',
      '--trace-deopt',
      '--trace-deopt-verbose',
      '--trace-file-names',
      fileURLToPath(import.meta.url),
      ...scriptArgs,
    ],
    { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 },
  )
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  }
}

function tail(text) {
  return text.trim().split('\n').slice(-30).join('\n')
}

function assertTrace(name, result) {
  if (result.error) throw new Error(`${name}: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${name} exited ${result.status}\n${tail(result.output)}`)
  }
  if (!result.output.includes('[completed ')) {
    throw new Error(`${name}: V8 printed no optimization trace`)
  }
  return parseTrace(result.output)
}

function formatDeopt(item) {
  return `${item.file} ${displayName(item.name)}: ${item.reason}`
}

function assertScenario(scenario, parsed) {
  const deopts = bundleDeopts(parsed)
  const missing = []
  for (const [file, name] of scenario.turbofan ?? []) {
    if (!tierAtLeast(parsed, file, name, 'TURBOFAN_JS')) {
      missing.push(`TurboFan ${file} ${displayName(name)}`)
    }
  }
  for (const [file, name] of scenario.optimized ?? []) {
    if (!tierAtLeast(parsed, file, name, 'MAGLEV')) {
      missing.push(`Maglev ${file} ${displayName(name)}`)
    }
  }
  if (deopts.length === 0 && missing.length === 0) return
  const lines = [`jit regression failed: ${scenario.name}`]
  if (missing.length > 0) {
    lines.push(`missing: ${missing.join(', ')}`)
    const seen = []
    for (const [key, tier] of parsed.tiers) {
      const [file, name] = key.split('\0')
      if (!bundleNames.has(file)) continue
      seen.push(`${tier} ${file} ${displayName(name)}`)
    }
    if (seen.length > 0) lines.push(`saw: ${seen.join(', ')}`)
  }
  if (deopts.length > 0) {
    lines.push(`hot-path deopts (${deopts.length}):`)
    for (const item of deopts.slice(0, 8)) lines.push(`  ${formatDeopt(item)}`)
  }
  throw new Error(lines.join('\n'))
}

async function runSelfTest(temporary) {
  const fixture = join(temporary, 'jit-self-test.mjs')
  writeFileSync(fixture, 'export function readX(obj) {\n  return obj.x + 1\n}\n')
  const parsed = assertTrace('self-test', traceChild(['--worker', 'self-test', fixture]))
  const deopts = parsed.deopts.filter(
    (item) => item.file === 'jit-self-test.mjs' && item.name === 'readX',
  )
  if (!deopts.some((item) => item.reason.includes('wrong map'))) {
    const saw = deopts.slice(0, 8).map((item) => formatDeopt(item))
    throw new Error(
      [
        'self-test did not record a wrong-map deopt, so this checker can no longer see JIT failures',
        saw.length === 0 ? 'saw: no readX deopt' : `saw: ${saw.join('; ')}`,
      ].join('\n'),
    )
  }
}

async function compileBundles(temporary) {
  const { rolldown } = await import('rolldown')
  const root = new URL('../', import.meta.url)
  const outputs = {}
  for (const [name, entry] of [
    ['protocol', 'src/protocol.ts'],
    ['core', 'src/view-anchor.ts'],
    ['size', 'src/size-anchor.ts'],
  ]) {
    const outfile = join(temporary, `${name}.js`)
    const bundle = await rolldown({
      input: fileURLToPath(new URL(entry, root)),
      platform: 'node',
      transform: { target: 'node24' },
    })
    try {
      await bundle.write({ file: outfile, format: 'esm' })
    } finally {
      await bundle.close()
    }
    outputs[name] = outfile
  }
  return outputs
}

async function runParent() {
  const onlyIndex = process.argv.indexOf('--only')
  const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1]
  const selected =
    only === undefined || only === 'self-test'
      ? only === 'self-test'
        ? []
        : scenarios
      : scenarios.filter((scenario) => scenario.name === only)
  if (only !== undefined && only !== 'self-test' && selected.length === 0) {
    throw new Error(`unknown scenario ${only}`)
  }

  assertParser()
  const temporary = mkdtempSync(join(tmpdir(), 'view-anchor-jit-'))
  const started = performance.now()
  try {
    await runSelfTest(temporary)
    if (selected.length === 0) {
      process.stdout.write('jit self-test passed\n')
      return
    }
    const bundles = await compileBundles(temporary)
    for (const scenario of selected) {
      const parsed = assertTrace(
        scenario.name,
        traceChild(['--worker', scenario.name, bundles.protocol, bundles.core, bundles.size]),
      )
      assertScenario(scenario, parsed)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  const elapsed = Math.round(performance.now() - started)
  process.stdout.write(
    `jit regression passed (${selected.length} hot paths, self-test saw wrong map, ${elapsed}ms, node ${process.version}, V8 ${process.versions.v8})\n`,
  )
}

async function runSelfTestWorker(fixturePath) {
  const { readX } = await import(pathToFileURL(fixturePath).href)
  let sink = 0
  const stable = { x: 1 }
  for (let index = 0; index < 200_000; index++) sink += readX(stable)
  // Install optimized code before changing the map. A polymorphic call that
  // lands first leaves no wrong-map deopt for the parser to see.
  await pause(200)
  for (let index = 0; index < 20_000; index++) sink += readX(stable)
  sink += readX({ y: 0, x: 1 })
  if (sink === 0) throw new Error('self-test did not run')
  await pause(200)
}

async function runWorker() {
  const name = process.argv[3]
  if (name === 'self-test') {
    await runSelfTestWorker(process.argv[4])
    return
  }
  const scenario = scenarios.find((item) => item.name === name)
  if (!scenario) throw new Error(`unknown scenario ${name}`)
  const modules = {
    protocol: await import(pathToFileURL(process.argv[4]).href),
    core: await import(pathToFileURL(process.argv[5]).href),
    size: await import(pathToFileURL(process.argv[6]).href),
  }
  await scenario.run(modules)
  await pause(800)
}

if (process.argv[2] === '--worker') await runWorker()
else await runParent()
