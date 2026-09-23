---
'view-anchor': major
---

feat: add `useSizeAnchor` React hook and enhanced `followScroll`; **BREAKING: remove `holdSelector`**

### BREAKING CHANGE: `holdSelector` option removed

The `holdSelector` option has been removed from `createViewAnchor` and `useViewAnchor`. This is a breaking change because:

- The `holdSelector` option no longer exists
- The pointer listeners (pointerdown/pointerup/pointercancel/blur) that tracked held pointers are removed
- Any code passing `holdSelector` must be updated

**Migration**: During a splitter drag, call `pulse()` after each pointer move that updates the layout. Calling it only on pointerdown is not enough: frame following closes after two steady frames, even if the pointer is still held.

```tsx
// Before (v0.x)
const handle = createViewAnchor(target, {
  visible: true,
  publish,
  followGeometry: true,
  holdSelector: '[role="separator"]', // removed
})

// After (v1.0)
const handle = createViewAnchor(target, {
  visible: true,
  publish,
  followGeometry: true,
})

// In your existing splitter drag handler, after applying each move:
splitter.addEventListener('pointermove', (event) => {
  if (!dragging) return // your existing drag state
  resizeFromPointer(event) // update the layout first
  handle.pulse() // follow the new position, including after a pause
})
```

For `useViewAnchor`, call `ref.pulse()` after updating the splitter layout in the same pointermove handler. The returned callback ref still attaches to the element; its `pulse()` method uses the current handle and is a no-op when detached or when `followGeometry` is off.

### `useSizeAnchor` React hook

Added a new `useSizeAnchor` hook in `view-anchor/react` that mirrors the `useViewAnchor` lifecycle:

- Callback ref pattern compatible with React 18 and 19
- StrictMode / React 19 cleanup microtask deferral
- Same deps / update semantics as `useViewAnchor`

```tsx
import { useSizeAnchor } from 'view-anchor/react'

function ContentSizer() {
  const ref = useSizeAnchor({
    axis: 'block',
    publish: updatePlaceholderHeight,
  })
  return <div ref={ref}>{/* dynamic content */}</div>
}
```

When the `axis` option changes (e.g., from `'block'` to `'inline'`), the hook disposes the old handle and recreates a new one.

### `followScroll` enhanced with scrollable ancestor listeners

When `followScroll: true`, the library now uses a hybrid approach:

- **Window capture-phase listener (fallback)**: Reliably catches all scrolls including `overflow:hidden` + programmatic `scrollLeft`/`scrollTop`, and works even before the element is connected or after reparenting without `update()`.
- **Scrollable ancestor listeners (enhancement)**: Catch scroll events in detached subtrees or shadow roots that do not reach window.

Events caught by the window listener are not processed again by ancestor listeners, including when `dedupe: false`. Ancestors are recollected on `update()` to handle target reparenting, while the window capture fallback ensures coverage when ancestors change unexpectedly.
