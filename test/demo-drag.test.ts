import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error jsdom does not include TypeScript declarations in this project
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const html = readFileSync(resolve(process.cwd(), 'docs/index.html'), 'utf8')

describe('interactive demo: header splitter', () => {
  it('follows moves even after the initial frames settle, and stops when followGeometry is off', () => {
    const frames: FrameRequestCallback[] = []
    const dom = new JSDOM(html, {
      url: 'https://example.test/',
      runScripts: 'dangerously',
      beforeParse(window: Window & typeof globalThis) {
        window.ResizeObserver = class implements ResizeObserver {
          constructor(_callback: ResizeObserverCallback) {}
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        }
        window.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback)
        window.cancelAnimationFrame = () => {}
        window.HTMLElement.prototype.setPointerCapture = () => {}
      },
    })
    try {
      const { window } = dom
      const splitter = window.document.getElementById('split-header')!
      const slotA = window.document.getElementById('slot-a')!
      const originalRect = slotA.getBoundingClientRect.bind(slotA)
      let measurements = 0
      slotA.getBoundingClientRect = () => {
        measurements++
        return originalRect()
      }
      const pointer = (type: string, y: number): void => {
        const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientY: y })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        splitter.dispatchEvent(event)
      }

      pointer('pointerdown', 0)
      // A pause between pressing and moving must not prevent later movement from being tracked.
      for (let i = 0; i < 3; i++) frames.shift()?.(i * 16)
      expect(frames).toHaveLength(0)
      pointer('pointermove', 50)
      expect(frames.length).toBeGreaterThan(0)
      frames.shift()?.(48)
      expect(measurements).toBeGreaterThan(0)

      window.document.getElementById('follow-geometry')!.click()
      frames.length = 0
      pointer('pointermove', 60)
      expect(frames).toHaveLength(0)
      pointer('pointerup', 60)

      window.document.getElementById('follow-geometry')!.click()
      pointer('pointerdown', 0)
      pointer('pointermove', 70)
      expect(frames.length).toBeGreaterThan(0)
      pointer('pointerup', 70)
    } finally {
      dom.window.close()
    }
  })
})
