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

  execFileSync('tar', ['-xzf', join(packDirectory, tarball), '-C', packageDirectory, '--strip-components=1'])

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

  const reactDirectory = join(consumerDirectory, 'node_modules', 'react')
  mkdirSync(reactDirectory)
  writeFileSync(join(reactDirectory, 'package.json'), '{"type":"module"}')
  writeFileSync(join(reactDirectory, 'index.js'), `
    export const useCallback = (callback) => callback
    export const useEffect = () => undefined
    export const useRef = (value) => ({ current: value })
  `)

  const core = runNode(`
    const core = await import('view-anchor')
    const required = [
      'createViewAnchor',
      'createPlacementAnchor',
      'measurePlacement',
      'createSizeAdvertiser',
      'useViewAnchor',
    ]
    const missing = required.filter((name) => !(name in core))
    if (missing.length > 0) throw new Error('Missing core exports: ' + missing.join(', '))
  `)
  if (core.status !== 0) {
    throw new Error(`The core package entry must load with React installed:\n${core.stderr}`)
  }

  const react = runNode("const react = await import('view-anchor/react'); if (typeof react.useViewAnchor !== 'function') throw new Error('Missing React export')")
  if (react.status !== 0) {
    throw new Error(`The React package entry must load with React installed:\n${react.stderr}`)
  }

  const typecheckFile = join(consumerDirectory, 'compat.mts')
  writeFileSync(typecheckFile, `
    import { useViewAnchor } from 'view-anchor'
    import type { UseViewAnchorOptions, ViewAnchorRef } from 'view-anchor'
    const options = { present: true, publish: () => undefined } satisfies UseViewAnchorOptions
    const ref: ViewAnchorRef = useViewAnchor(options)
    void ref
  `)
  execFileSync('pnpm', [
    'exec', 'tsc', '--noEmit', '--strict', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', typecheckFile,
  ], { cwd: projectRoot, stdio: 'inherit' })

  console.log('Package entry checks passed: protocol loads without React; root and React entries keep legacy React exports.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
