# view-anchor

> An engine-agnostic primitive that keeps a main-process native view aligned to a DOM element's geometry.

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

In Electron, a native `WebContentsView` lives in the main process while your layout lives in the renderer. Layout libraries (flexbox, dockview, react-resizable-panels…) only move DOM nodes — they have no idea where the process boundary is. `view-anchor` is the bridge across it: it measures a target element's `getBoundingClientRect()`, hands the rectangle to a `publish` callback (your IPC → `setBounds`), and re-publishes whenever the element moves or resizes.

The core has no dependencies on React, Electron, or any host layout engine. React code lives only in the adapter layer.

## Features

- **One-to-one binding** — a single native view follows a single DOM element. `update()` applies new options and re-publishes immediately.
- **Synchronous, deduplicated publishes** — measures and publishes in the same observer tick, so the native view never trails the DOM by more than the unavoidable cross-process frame. Rects identical to the last publish are dropped.
- **Collapse without destroying** — `present: false` publishes a zero rect and stops observing; the host can detach the subview while keeping the `WebContents` alive.
- **Explicit visibility** — the `Placement` API distinguishes a genuinely 0×0-but-visible view from a hidden one, instead of inferring visibility from geometry.
- **Content-driven sizing (reverse direction)** — `createSizeAdvertiser` reports a view's own content size back so a DOM placeholder can grow to match.
- **React adapter** — `useViewAnchor` hook that attaches to a placeholder element.
- **Zero-dependency core** — no React, no Electron, no layout-engine imports in the core.

## Installation

```bash
pnpm add view-anchor
# or
npm install view-anchor
```

React is an optional peer dependency; you only need it for the `useViewAnchor` adapter.

## Quick start

### Imperative core

```ts
import { createViewAnchor } from 'view-anchor'

const handle = createViewAnchor(target, {
  present: true,                 // mount the native view
  publish: (bounds) => { ... },  // receive live rectangles; wire IPC → setBounds
})

handle.update({ present, publish }) // apply new options, re-publishes immediately
handle.dispose()                    // stop observing; never publishes again
```

### React

```tsx
import { useViewAnchor } from 'view-anchor'

function DebugPanel({ visible }: { visible: boolean }) {
  const ref = useViewAnchor({
    present: visible,
    publish: publishPanelBounds,
  })
  // The native view follows this placeholder div. Hiding the panel
  // (visible=false or unmount) collapses it without destroying it.
  return <div ref={ref} className="h-full w-full" />
}
```

### Reverse: content size reporting

When a `WebContentsView`'s size is driven by its own content (for example a toolbar owned by downstream code), run inside that view's own renderer process:

```ts
import { createSizeAdvertiser } from 'view-anchor'

const handle = createSizeAdvertiser(contentWrapper, {
  axis: 'block',                 // this advertiser owns one axis only (block=height / inline=width)
  publish: (size) => { ... },    // receives { axis, extent }; wire IPC → host
})

handle.update(publish) // swap the publish channel and immediately report the current size
handle.dispose()       // stop observing; never reports again
```

> **Warning:** the `target` must shrink-to-fit on the owned axis — if its size is set by the hosted view instead, the cross-process loop cannot converge. See [docs/bidirectional-design.md](./docs/bidirectional-design.md).

## API

| Export | Kind | Purpose |
|---|---|---|
| `createViewAnchor(target, opts)` | function | Imperative core: measure and publish live bounds. Zero rect means collapsed. |
| `createPlacementAnchor(target, opts)` | function | Same core with explicit `Placement` visibility, plus opt-in `followScroll` / `followGeometry` / `guardDisplayNone` and `pulse()`. |
| `measurePlacement(target)` | function | Pure measurement: wraps the target rect as `{ visible: true, bounds }`. |
| `useViewAnchor(opts)` | hook | React adapter returning a ref callback for a placeholder element. |
| `createSizeAdvertiser(target, opts)` | function | Reverse core: report the view's own content size to the host. |
| `Bounds` | type | `{ x, y, width, height }` in CSS pixels. |
| `Placement` | type | `{ visible: true; bounds } \| { visible: false }` — explicit visibility. |
| `ViewAnchorOptions` / `ViewAnchorHandle` | type | Options and handle for the forward zero-rect core. |
| `PlacementAnchorOptions` / `PlacementAnchorHandle` | type | Options and handle for the `Placement` core. |
| `UseViewAnchorOptions` / `ViewAnchorRef` | type | Options and ref shape for the React adapter. |
| `AdvertisedAxis` / `AdvertisedSize` | type | Reverse axis and frame payload types. |
| `SizeAdvertiserOptions` / `SizeAdvertiserHandle` | type | Options and handle for the reverse core. |

## Documentation

- [docs/mechanism.mdx](./docs/mechanism.mdx) — the forward mechanism in depth: synchronous publishing and stale-frame safety, the `present` / zero-rect / unmount contract, React 18 StrictMode behavior. Includes an interactive 3D demo at [docs/anchor-3d.html](./docs/anchor-3d.html).
- [docs/bidirectional-design.md](./docs/bidirectional-design.md) — the bidirectional geometry bridge: the intentional sync/RAF asymmetry, single-axis ownership and convergence, trust boundaries.

## Contributing

Issues and pull requests are welcome. Before submitting, run the checks locally: `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm build`.

## License

[MIT](./LICENSE) © lbb00
