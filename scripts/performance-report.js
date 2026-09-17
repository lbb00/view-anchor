import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

if (typeof globalThis.gc !== 'function') {
  throw new Error('Run with node --expose-gc so memory measurements are explicit')
}

const root = new URL('../', import.meta.url)
const rootPath = fileURLToPath(root)
const samples = 7
const warmups = 2
const anchorCount = 10_000
const largeCount = 100_000
const freshProcesses = 3

async function compile(entry, outfile) {
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
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.floor(ordered.length / 2)]
}

function timing(run) {
  for (let index = 0; index < warmups; index++) run()
  const values = []
  for (let index = 0; index < samples; index++) {
    globalThis.gc()
    const startedAt = performance.now()
    run()
    values.push(performance.now() - startedAt)
  }
  return {
    unit: 'ms',
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values,
  }
}

function preparedTiming(setup, run, cleanup) {
  const execute = (record) => {
    const state = setup()
    globalThis.gc()
    const startedAt = performance.now()
    run(state)
    if (record) record.push(performance.now() - startedAt)
    cleanup?.(state)
  }
  for (let index = 0; index < warmups; index++) execute()
  const values = []
  for (let index = 0; index < samples; index++) execute(values)
  return {
    unit: 'ms',
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values,
  }
}

async function bundledContents(input, plugins = []) {
  const bundle = await rolldown({ input, external: ['react'], plugins })
  try {
    const { output } = await bundle.generate({ format: 'esm', minify: true })
    const chunk = output.find((asset) => asset.type === 'chunk')
    if (!chunk) throw new Error('rolldown produced no JavaScript chunk')
    return Buffer.from(chunk.code)
  } finally {
    await bundle.close()
  }
}

async function bundleSize(entry) {
  const contents = await bundledContents(fileURLToPath(new URL(entry, root)))
  return {
    rawBytes: contents.length,
    gzipBytes: gzipSync(contents).length,
    brotliBytes: brotliCompressSync(contents).length,
  }
}

async function exportSize(entry, name) {
  const virtualEntry = `\0view-anchor-export-size:${name}`
  const source = fileURLToPath(new URL(entry, root))
  const contents = await bundledContents(virtualEntry, [
    {
      name: 'view-anchor-export-size',
      resolveId(id) {
        return id === virtualEntry ? id : null
      },
      load(id) {
        return id === virtualEntry ? `export { ${name} } from ${JSON.stringify(source)}` : null
      },
    },
  ])
  return {
    rawBytes: contents.length,
    gzipBytes: gzipSync(contents).length,
    brotliBytes: brotliCompressSync(contents).length,
  }
}

function isolatedMemory(protocolPath, scenario) {
  const worker = fileURLToPath(new URL('./performance-memory-worker.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', worker, pathToFileURL(protocolPath).href, scenario, String(largeCount)],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`isolated ${scenario} memory benchmark failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function aggregateTiming(reports, name) {
  const timings = reports.map((report) => report.timings[name])
  const processMedians = timings.map((timing) => timing.median)
  return {
    unit: timings[0].unit,
    median: median(processMedians),
    min: Math.min(...timings.map((timing) => timing.min)),
    max: Math.max(...timings.map((timing) => timing.max)),
    processMedians,
    samples: timings.flatMap((timing) => timing.samples),
  }
}

function aggregateMemory(reports) {
  const aggregate = (values) => median(values)
  const batcher = Object.fromEntries(
    ['pending', 'retainedAfterFlush', 'afterClear'].map((state) => [
      state,
      {
        heapDeltaBytes: aggregate(
          reports.map((report) => report.memory.batcher[state].heapDeltaBytes),
        ),
        rssDeltaBytes: aggregate(
          reports.map((report) => report.memory.batcher[state].rssDeltaBytes),
        ),
      },
    ]),
  )
  const sequenceGuard = Object.fromEntries(
    ['retained', 'afterClear'].map((state) => [
      state,
      {
        heapDeltaBytes: aggregate(
          reports.map((report) => report.memory.sequenceGuard[state].heapDeltaBytes),
        ),
        rssDeltaBytes: aggregate(
          reports.map((report) => report.memory.sequenceGuard[state].rssDeltaBytes),
        ),
      },
    ]),
  )
  return { anchors: largeCount, batcher, sequenceGuard }
}

async function runSample() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with node --expose-gc so memory measurements are explicit')
  }
  mkdirSync(join(rootPath, '.tmp'), { recursive: true })
  const temporary = mkdtempSync(join(rootPath, '.tmp', 'performance-'))
  try {
    return await runSampleIn(temporary)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

async function runSampleIn(temporary) {
  const protocolPath = join(temporary, 'protocol.js')
  const corePath = join(temporary, 'core.js')
  await compile('src/protocol.ts', protocolPath)
  await compile('src/view-anchor.ts', corePath)
  const {
    createGeometryBatcher,
    createPlacementMessagePublisher,
    createGeometrySequenceGuard,
    decodeGeometryWireValue,
  } = await import(pathToFileURL(protocolPath).href)
  const { measurePlacement } = await import(pathToFileURL(corePath).href)

  // Benchmarks call flush explicitly; suppressing scheduled callbacks keeps the
  // measured operation deterministic without changing batcher state.
  globalThis.queueMicrotask = () => {}

  const message = (index, generation) => ({
    v: 1,
    kind: 'placement',
    anchorId: `anchor-${index}`,
    generation,
    seq: 1,
    placement: { visible: false },
  })

  const seededBatcher = (count) => {
    const batcher = createGeometryBatcher(() => true)
    for (let index = 0; index < count; index++) batcher.publish(message(index, 1))
    batcher.flush()
    return batcher
  }
  const generationUpgrade = preparedTiming(
    () => seededBatcher(anchorCount),
    (batcher) => {
      for (let index = 0; index < anchorCount; index++) batcher.publish(message(index, 2))
    },
    (batcher) => batcher.dispose(),
  )
  const clearAnchors = preparedTiming(
    () => seededBatcher(anchorCount),
    (batcher) => {
      for (let index = 0; index < anchorCount; index++) batcher.clear(`anchor-${index}`)
    },
    (batcher) => batcher.dispose(),
  )
  const sparseFlush = preparedTiming(
    () => {
      const batcher = seededBatcher(largeCount)
      batcher.publish({ ...message(0, 1), seq: 2 })
      return batcher
    },
    (batcher) => batcher.flush(),
    (batcher) => batcher.dispose(),
  )

  let lastPublishedMessage
  const publishPlacement = createPlacementMessagePublisher(
    { anchorId: 'publisher-benchmark', generation: 1 },
    (value) => {
      lastPublishedMessage = value
    },
  )
  const publisher = timing(() => {
    for (let index = 0; index < 1_000_000; index++) {
      publishPlacement({ visible: false })
    }
    if (lastPublishedMessage?.seq === 0) throw new Error('publisher benchmark did not run')
  })

  const steadyBatcher = timing(() => {
    const batcher = createGeometryBatcher(() => true)
    for (let seq = 1; seq <= largeCount; seq++) {
      batcher.publish({
        v: 1,
        kind: 'placement',
        anchorId: 'steady-anchor',
        generation: 1,
        seq,
        placement: { visible: false },
      })
      batcher.flush()
    }
    batcher.dispose()
  })

  const validMessages = Array.from({ length: largeCount }, (_, index) => ({
    ...message(index, 1),
    placement: {
      visible: true,
      bounds: { x: index, y: -index, width: 100, height: 50 },
    },
  }))
  const validBatch = { v: 1, kind: 'batch', messages: validMessages }
  const invalidBatch = {
    v: 1,
    kind: 'batch',
    messages: [...validMessages.slice(0, -1), { bad: true }],
  }
  const decodeValid = timing(() => {
    if (!decodeGeometryWireValue(validBatch, { maxMessages: largeCount }).ok) {
      throw new Error('valid decode benchmark input was rejected')
    }
  })
  const decodeInvalidTail = timing(() => {
    if (decodeGeometryWireValue(invalidBatch, { maxMessages: largeCount }).ok) {
      throw new Error('invalid decode benchmark input was accepted')
    }
  })

  const sequenceGuard = timing(() => {
    const guard = createGeometrySequenceGuard()
    for (let index = 0; index < largeCount; index++) guard.accept(message(index, 1))
    guard.clear()
  })

  const target = {
    getBoundingClientRect() {
      return { left: -1.25, top: 2.75, width: 100.5, height: 50.25 }
    },
  }
  const measure = timing(() => {
    for (let index = 0; index < 1_000_000; index++) measurePlacement(target)
  })

  const batcherMemory = isolatedMemory(protocolPath, 'batcher')
  const guardMemory = isolatedMemory(protocolPath, 'guard')

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
    },
    method: { warmups, samples, anchorCount, largeCount, exposedGc: true },
    timings: {
      generationUpgrade,
      clearAnchors,
      sparseFlush,
      publisherMillion: publisher,
      steadyBatcher100k: steadyBatcher,
      decodeValid,
      decodeInvalidTail,
      sequenceGuard,
      measurePlacementMillion: measure,
    },
    memory: {
      anchors: largeCount,
      batcher: batcherMemory,
      sequenceGuard: guardMemory.sequenceGuard,
    },
    exportedBundleSize: {
      fullEntries: {
        core: await bundleSize('src/index.ts'),
        protocol: await bundleSize('src/protocol.ts'),
        react: await bundleSize('src/react.ts'),
      },
      treeShakenExports: Object.fromEntries(
        await Promise.all(
          [
            ['core/createViewAnchor', 'src/index.ts', 'createViewAnchor'],
            ['core/measurePlacement', 'src/index.ts', 'measurePlacement'],
            ['core/createSizeAnchor', 'src/index.ts', 'createSizeAnchor'],
            ['protocol/decodeGeometryWireValue', 'src/protocol.ts', 'decodeGeometryWireValue'],
            [
              'protocol/createGeometrySequenceGuard',
              'src/protocol.ts',
              'createGeometrySequenceGuard',
            ],
            ['protocol/createGeometryBatcher', 'src/protocol.ts', 'createGeometryBatcher'],
            [
              'protocol/createPlacementMessagePublisher',
              'src/protocol.ts',
              'createPlacementMessagePublisher',
            ],
            [
              'protocol/createSizeMessagePublisher',
              'src/protocol.ts',
              'createSizeMessagePublisher',
            ],
            ['react/useViewAnchor', 'src/react.ts', 'useViewAnchor'],
          ].map(async ([label, entry, name]) => [label, await exportSize(entry, name)]),
        ),
      ),
    },
  }
  return report
}

const sampleOutputIndex = process.argv.indexOf('--sample-output')

if (process.argv.includes('--sample')) {
  if (sampleOutputIndex < 0) {
    throw new Error('sample benchmarks require a --sample-output file')
  }
  const sampleOutput = process.argv[sampleOutputIndex + 1]
  if (sampleOutput === undefined) {
    throw new Error('sample benchmarks require a --sample-output file')
  }
  writeFileSync(sampleOutput, JSON.stringify(await runSample()))
} else {
  const reportTemporary = mkdtempSync('/tmp/view-anchor-performance-report-')
  try {
    const reports = []
    for (let index = 0; index < freshProcesses; index++) {
      const execArgs = process.execArgv.includes('--expose-gc')
        ? process.execArgv
        : ['--expose-gc', ...process.execArgv]
      const sampleOutput = join(reportTemporary, `sample-${index}.json`)
      const result = spawnSync(
        process.execPath,
        [...execArgs, fileURLToPath(import.meta.url), '--sample', '--sample-output', sampleOutput],
        { cwd: rootPath, stdio: 'inherit' },
      )
      if (result.status !== 0) {
        throw new Error(`fresh benchmark process ${index + 1} failed with exit ${result.status}`)
      }
      reports.push(JSON.parse(readFileSync(sampleOutput, 'utf8')))
    }
    const first = reports[0]
    const report = {
      generatedAt: new Date().toISOString(),
      environment: first.environment,
      method: { ...first.method, freshProcesses },
      timings: Object.fromEntries(
        Object.keys(first.timings).map((name) => [name, aggregateTiming(reports, name)]),
      ),
      memory: aggregateMemory(reports),
      exportedBundleSize: first.exportedBundleSize,
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    rmSync(reportTemporary, { recursive: true, force: true })
  }
}
