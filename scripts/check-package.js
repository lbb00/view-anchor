import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const tempRoot = mkdtempSync(join(tmpdir(), 'view-anchor-package-'))
const packDirectory = join(tempRoot, 'pack')
const consumerDirectory = join(tempRoot, 'consumer')
const packageDirectory = join(consumerDirectory, 'node_modules', 'view-anchor')

function runNode(source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: consumerDirectory,
    encoding: 'utf8',
  })
}

try {
  mkdirSync(packDirectory)
  mkdirSync(packageDirectory, { recursive: true })
  execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
    cwd: projectRoot,
    stdio: 'inherit',
  })

  const tarball = readdirSync(packDirectory).find((name) => name.endsWith('.tgz'))
  if (!tarball) throw new Error('pnpm pack did not create a tarball')

  execFileSync('tar', [
    '-xzf',
    join(packDirectory, tarball),
    '-C',
    packageDirectory,
    '--strip-components=1',
  ])

  // Every compiled module must still have a source file: a build that does not
  // start from an empty dist would otherwise ship modules deleted from src.
  const shippedSources = new Set(readdirSync(join(packageDirectory, 'src')))
  const staleOutputs = readdirSync(join(packageDirectory, 'dist')).filter((name) => {
    const module = name.replace(/\.(d\.ts|js)(\.map)?$/, '')
    return !shippedSources.has(`${module}.ts`)
  })
  if (staleOutputs.length > 0) {
    throw new Error(`dist contains outputs without a source file: ${staleOutputs.join(', ')}`)
  }

  const protocol = runNode(`
    const protocol = await import('view-anchor/protocol')
    const required = [
      'GEOMETRY_PROTOCOL_VERSION',
      'decodeGeometryWireValue',
      'createGeometrySequenceGuard',
      'createPlacementMessagePublisher',
      'createSizeMessagePublisher',
      'createGeometryBatcher',
    ]
    const missing = required.filter((name) => !(name in protocol))
    if (missing.length > 0) throw new Error('Missing protocol exports: ' + missing.join(', '))
  `)
  if (protocol.status !== 0) {
    throw new Error(`The protocol package entry must load without React:\n${protocol.stderr}`)
  }

  // The root entry must not depend on React (useViewAnchor lives only in the
  // React entry), so it is checked here, before react/index.js exists.
  const core = runNode(`
    const core = await import('view-anchor')
    const required = ['createViewAnchor', 'measurePlacement', 'createSizeAnchor']
    const missing = required.filter((name) => !(name in core))
    if (missing.length > 0) throw new Error('Missing core exports: ' + missing.join(', '))
    if ('useViewAnchor' in core) throw new Error('The root entry must not export useViewAnchor')
  `)
  if (core.status !== 0) {
    throw new Error(`The root package entry must load without React:\n${core.stderr}`)
  }

  const reactDirectory = join(consumerDirectory, 'node_modules', 'react')
  mkdirSync(reactDirectory)
  writeFileSync(join(reactDirectory, 'package.json'), '{"type":"module"}')
  writeFileSync(
    join(reactDirectory, 'index.js'),
    `
    export const useCallback = (callback) => callback
    export const useEffect = () => undefined
    export const useInsertionEffect = () => undefined
    export const useRef = (value) => ({ current: value })
    export const version = '18.3.1'
  `,
  )

  const react = runNode(
    "const react = await import('view-anchor/react'); if (typeof react.useViewAnchor !== 'function') throw new Error('Missing useViewAnchor')",
  )
  if (react.status !== 0) {
    throw new Error(`The React package entry must load with React installed:\n${react.stderr}`)
  }

  const typecheckFile = join(packageDirectory, 'compat-check.ts')
  writeFileSync(
    typecheckFile,
    `
    import { createViewAnchor, createSizeAnchor, measurePlacement } from 'view-anchor'
    import type {
      Bounds,
      Placement,
      Publisher,
      PublishResult,
      ViewAnchorOptions,
      ViewAnchorHandle,
      SizeAxis,
      SizeMeasurement,
      SizeAnchorOptions,
      SizeAnchorHandle,
    } from 'view-anchor'

    const bounds: Bounds = { x: 0, y: 0, width: 1, height: 1 }
    const placement: Placement = measurePlacement(document.body)
    void bounds
    const publishResult: PublishResult = undefined
    void publishResult
    const publishPlacement: Publisher<Placement> = () => undefined
    void publishPlacement

    const anchorOptions = { visible: true, publish: publishPlacement } satisfies ViewAnchorOptions
    const anchorHandle: ViewAnchorHandle = createViewAnchor(document.body, anchorOptions)
    anchorHandle.dispose()

    const axis: SizeAxis = 'block'
    const publishSize: Publisher<SizeMeasurement> = () => undefined
    const sizeOptions = { axis, publish: publishSize } satisfies SizeAnchorOptions
    const sizeHandle: SizeAnchorHandle = createSizeAnchor(document.body, sizeOptions)
    sizeHandle.update({ publish: publishSize })
    sizeHandle.dispose()
    void placement

    import { useViewAnchor } from 'view-anchor/react'
    import type { UseViewAnchorOptions, ViewAnchorRef } from 'view-anchor/react'
    const reactOptions = { visible: true, publish: publishPlacement } satisfies UseViewAnchorOptions
    const ref: ViewAnchorRef = useViewAnchor(reactOptions)
    void ref

    import {
      GEOMETRY_PROTOCOL_VERSION,
      decodeGeometryWireValue,
      createGeometrySequenceGuard,
      createGeometryBatcher,
      createPlacementMessagePublisher,
      createSizeMessagePublisher,
    } from 'view-anchor/protocol'
    import type {
      GeometrySequenceGuard,
      GeometryBatcher,
      GeometryBatcherOptions,
      GeometryBatchSender,
      GeometryMessageSender,
    } from 'view-anchor/protocol'
    void GEOMETRY_PROTOCOL_VERSION
    void decodeGeometryWireValue
    void createGeometrySequenceGuard
    void createGeometryBatcher
    void createPlacementMessagePublisher
    void createSizeMessagePublisher
    declare const guard: GeometrySequenceGuard
    declare const batcher: GeometryBatcher
    declare const batcherOptions: GeometryBatcherOptions
    declare const batchSend: GeometryBatchSender
    declare const send: GeometryMessageSender
    void guard
    void batcher
    void batcherOptions
    void batchSend
    void send
  `,
  )
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--lib',
      'ES2022,DOM',
      typecheckFile,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  )

  console.log(
    'Package entry checks passed: protocol and root entries load without React; React entry loads with React installed and exports useViewAnchor.',
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
