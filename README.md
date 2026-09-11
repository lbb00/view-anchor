# view-anchor

> A high-performance geometry bridge that keeps a main-process native view aligned with renderer DOM.

[![npm version](https://img.shields.io/npm/v/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![npm downloads](https://img.shields.io/npm/dm/view-anchor)](https://www.npmjs.com/package/view-anchor)
[![License](https://img.shields.io/npm/l/view-anchor)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)

[English](./README.md) · [简体中文](./README.zh-CN.md)

> 🎮 **Live demo**: the [3D interactive demo](https://lbb00.github.io/view-anchor/) runs the real core in your browser — resize the splitter, toggle presence, and watch the native view follow.

In Electron, a native `WebContentsView` lives in the main process while your layout lives in the renderer. Layout libraries (flexbox, dockview, react-resizable-panels…) only move DOM nodes — they have no idea where the process boundary is. `view-anchor` bridges that gap: it measures a target element, hands the rectangle to your `publish` callback, and updates the native view when the DOM moves or resizes.

The hot paths are deliberately small: synchronous delivery, scalar deduplication before payload allocation in reverse size reporting, bounded animation-frame following, fixed-shape state for V8, and latest-value microtask batching. CPU, retained memory, V8 optimization, and actual tree-shaken output are measured by a reproducible benchmark rather than inferred from source style.

## Features

- **One-to-one binding** — a single native view follows a single DOM element. `update()` applies new options and re-publishes immediately.
- **Synchronous, deduplicated publishes** — measures and publishes in the same observer tick. Geometry identical to the last accepted value is not sent again.
- **Collapse without destroying** — `present: false` publishes a zero rect and stops observing; the host can detach the subview while keeping the `WebContents` alive.
- **Explicit visibility** — the `Placement` API distinguishes a genuinely 0×0-but-visible view from a hidden one, instead of inferring visibility from geometry.
- **Content-driven sizing (reverse direction)** — `createSizeAdvertiser` reports a view's own content size back so a DOM placeholder can grow to match.
- **Low-overhead wire protocol** — `view-anchor/protocol` adds versioned envelopes, bounded runtime decoding, O(1) per-anchor generation changes, latest-wins ordering, and same-task microtask batching.
- **React adapter** — `useViewAnchor` hook that attaches to a placeholder element.
- **Framework-neutral internals** — geometry and transport code do not import Electron or a layout engine; React remains isolated in the adapter module.

## Performance

Performance is treated as a reproducible engineering constraint. `pnpm benchmark` measures CPU, retained heap, RSS, extreme anchor counts, and actual tree-shaken output across fresh Node.js processes; `pnpm benchmark:v8` adds optimization, inlining, and deoptimization traces. See the [full performance report](./docs/performance-report.md) for results, methodology, and measurement boundaries.

## Installation

```bash
pnpm add view-anchor
# or
npm install view-anchor
```

React is an optional peer dependency for the package. Import hooks from `view-anchor/react`. The root entry also re-exports `useViewAnchor` for compatibility with `v0.1.2`, so applications that load `view-anchor` must have React installed. `view-anchor/protocol` can be loaded without React.

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
import { useViewAnchor } from 'view-anchor/react'

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

For explicit `Placement` visibility and automatic scroll or geometry following, import `usePlacementAnchor` from the same entry.

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

### Versioned transport

The core still accepts raw `Bounds`, `Placement`, and `AdvertisedSize` callbacks. When a process boundary needs validation and ordering, use the optional protocol entry:

```ts
import {
  createGeometryBatcher,
  createPlacementMessagePublisher,
  decodeGeometryWireValue,
} from 'view-anchor/protocol'

const batcher = createGeometryBatcher((batch) => ipc.send('geometry', batch))
const publish = createPlacementMessagePublisher(
  { anchorId: 'editor', generation: 3 },
  batcher.publish,
)

const decoded = decodeGeometryWireValue(received, { maxMessages: 100 })
if (decoded.ok) { /* authorize the sender, then apply only newer messages */ }
```

The publisher returned by `createPlacementMessagePublisher`/`createSizeMessagePublisher` must stay the SAME object for the life of one `{anchorId, generation}` (cache it with `useMemo`/`useRef` in React, not built inline on every render). The batcher and `createGeometrySequenceGuard` track a per-anchor sequence high-water mark; recreating a publisher at an unchanged address restarts its `seq` at 1 while that mark is already ahead, so its messages get dropped as stale. Bump `generation` when you need a genuinely new publisher. See [docs/protocol.md](./docs/protocol.md).

Returning `false` from a synchronous publisher means “not accepted”; the core retries the same geometry on the next trigger. A batching publisher returns `true` after queueing and owns later delivery retries. See [docs/protocol.md](./docs/protocol.md) for the complete contract.

## API

| Export | Kind | Purpose |
|---|---|---|
| `createViewAnchor(target, opts)` | function | Imperative core: measure and publish live bounds. Zero rect means collapsed. |
| `createPlacementAnchor(target, opts)` | function | Same core with explicit `Placement` visibility, plus opt-in `followScroll` / `followGeometry` / `guardDisplayNone` and `pulse()`. |
| `measurePlacement(target)` | function | Pure measurement: wraps the target rect as `{ visible: true, bounds }`. |
| `useViewAnchor(opts)` from `view-anchor/react` | hook | React adapter returning a ref callback for a placeholder element. |
| `usePlacementAnchor(opts)` from `view-anchor/react` | hook | React adapter for the explicit `Placement` API, including `followScroll` and `followGeometry`. |
| `createSizeAdvertiser(target, opts)` | function | Reverse core: report the view's own content size to the host. |
| `Bounds` | type | `{ x, y, width, height }` in CSS pixels. |
| `Placement` | type | `{ visible: true; bounds } \| { visible: false }` — explicit visibility. |
| `ViewAnchorOptions` / `ViewAnchorHandle` | type | Options and handle for the forward zero-rect core. |
| `PlacementAnchorOptions` / `PlacementAnchorHandle` | type | Options and handle for the `Placement` core. |
| `UseViewAnchorOptions` / `ViewAnchorRef` from `view-anchor/react` | type | Options and ref shape for the React adapter. |
| `UsePlacementAnchorOptions` / `PlacementAnchorRef` from `view-anchor/react` | type | Options and ref shape for the explicit `Placement` React adapter. |
| `AdvertisedAxis` / `AdvertisedSize` | type | Reverse axis and frame payload types. |
| `SizeAdvertiserOptions` / `SizeAdvertiserHandle` | type | Options and handle for the reverse core. |
| Exports from `view-anchor/protocol` | functions + types | Versioned messages, strict decoding, latest-wins guards, message publishers, and microtask batching. |

## Documentation

- [docs/mechanism.mdx](./docs/mechanism.mdx) — the forward mechanism in depth: synchronous publishing and stale-frame safety, the `present` / zero-rect / unmount contract, React 18/19 StrictMode behavior. Includes the interactive 3D demo at [docs/index.html](./docs/index.html).
- [docs/bidirectional-design.md](./docs/bidirectional-design.md) — the bidirectional geometry bridge: the intentional sync/RAF asymmetry, single-axis ownership and convergence, trust boundaries.
- [docs/protocol.md](./docs/protocol.md) — versioned transport envelopes, validation, ordering, batching, and failure semantics.
- [docs/performance-report.md](./docs/performance-report.md) — reproducible CPU, heap, RSS, extreme-case, V8, and tree-shaken export-size measurements.

## Contributing

Issues and pull requests are welcome. Before submitting, run the checks locally: `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm build`. Run `pnpm benchmark` for the reproducible CPU, heap, RSS, and tree-shaken output report.

## License

[MIT](./LICENSE) © lbb00
