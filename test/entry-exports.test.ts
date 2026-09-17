import { describe, expect, it } from 'vitest'
import * as core from '../src/index.js'
import * as react from '../src/react.js'

// Pins the root entry's exported surface. useViewAnchor is React-only;
// the root entry does not re-export it so it remains React-free.
describe('root entry (src/index.ts) export surface', () => {
  it('exports exactly the runtime API', () => {
    expect(Object.keys(core).sort()).toEqual(
      ['createSizeAnchor', 'createViewAnchor', 'measurePlacement'].sort(),
    )
  })

  it('does not export useViewAnchor', () => {
    expect('useViewAnchor' in core).toBe(false)
  })
})

describe('React entry (src/react.ts) export surface', () => {
  it('exports exactly useViewAnchor', () => {
    expect(Object.keys(react).sort()).toEqual(['useViewAnchor'].sort())
  })
})
