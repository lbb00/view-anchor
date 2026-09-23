# view-anchor

## 1.0.0-beta.2

### Major Changes

- 0c844ce: feat: add `useSizeAnchor` React hook and enhanced `followScroll`; **BREAKING: remove `holdSelector`**

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

## 1.0.0-beta.1

### Patch Changes

- Test-only change: the batcher's flush-cost test now counts the reads it makes against the anchor map instead of comparing two wall-clock spans, so a shared CI runner no longer fails it on timing noise. Runtime behavior is unchanged.

## 1.0.0-beta.0

### Major Changes

- d66bb72: 1.0 release. Public API consolidated to a single explicit-visibility anchor; several exports removed or renamed.

  - **Breaking:** removed the old `Bounds`/`present`-based `createViewAnchor` and its `ViewAnchorOptions`/`ViewAnchorHandle` types. The former `createPlacementAnchor` (explicit `Placement`/`visible`-based) is now `createViewAnchor`, and its `PlacementAnchorOptions`/`PlacementAnchorHandle` types are now `ViewAnchorOptions`/`ViewAnchorHandle`. No compatibility alias — `publish` now always receives a `Placement` (`{ visible: true, bounds } | { visible: false }`), never a bare zero rectangle for "collapsed".
  - **Breaking:** in `view-anchor/react`, removed the old `Bounds`-based `useViewAnchor`. The former `usePlacementAnchor` is now `useViewAnchor`, and its `UsePlacementAnchorOptions`/`PlacementAnchorRef` types are now `UseViewAnchorOptions`/`ViewAnchorRef`.
  - **Breaking:** the root entry (`view-anchor`) no longer re-exports `useViewAnchor` or any React-only type. It has no React dependency; import `useViewAnchor` from `view-anchor/react` only.
  - **Breaking:** renamed `createSizeAdvertiser` to `createSizeAnchor`, and `SizeAdvertiserOptions`/`SizeAdvertiserHandle` to `SizeAnchorOptions`/`SizeAnchorHandle`. The size payload types `AdvertisedAxis`/`AdvertisedSize` are now `SizeAxis`/`SizeMeasurement`.
  - **Breaking:** renamed the `guardDisplayNone` option to `treatZeroAreaAsHidden`. Behavior unchanged: any target whose rounded width or height is 0 (not only `display: none`) publishes `{ visible: false }`.
  - **Breaking:** in `view-anchor/protocol`, renamed the callback types `GeometrySend`/`GeometryBatchSend` to `GeometryMessageSender`/`GeometryBatchSender`.
  - Added `dedupe` to `ViewAnchorOptions` and `SizeAnchorOptions`, default `true`: a measurement identical to the last accepted value is not published again. Set `dedupe: false` to receive every measurement, even unchanged ones. Omitting it — at creation, in `useViewAnchor`, or in either handle's `update()` — resets it to `true`.
  - Added `holdSelector` to `createViewAnchor` / `useViewAnchor`: a CSS selector for the press-and-hold target that keeps `followGeometry` active while a pointer is held. Defaults to `[role="separator"]`; pass `null` to disable pointer-hold tracking.
  - The pointerdown/pointerup/pointercancel/blur listener group is now mounted only while both `followGeometry` and `holdSelector` are set, not whenever `followGeometry` is on.
  - A non-empty `holdSelector` must be a syntactically valid CSS selector; an invalid one throws synchronously (SyntaxError) at `createViewAnchor` or `update()` time, before any option is applied.
  - **Breaking:** `ViewAnchorHandle.update()` now applies a full configuration, same as creation: any omitted option (including `holdSelector` and `dedupe`) resets to its default. Its type no longer accepts `signal` (`Omit<ViewAnchorOptions, 'signal'>`) — `signal` is only read once at creation, so passing it to `update()` is now a type error.
  - **Breaking:** `SizeAnchorHandle.update()` now takes an options object (`{ publish, dedupe? }`) instead of a bare `publish` callback; `dedupe` can now be changed through `update()`, and an omitted `dedupe` resets to `true`. Its type excludes `signal` and `axis` (`Omit<SizeAnchorOptions, 'signal' | 'axis'>`), both of which stay fixed for the anchor's lifetime.
  - Removed `engines.node` from package.json.
  - `useViewAnchor` no longer passes options from a render that never commits (e.g. a suspended transition) to the mounted anchor; an unmount collapses through the last committed `publish`.
  - `useViewAnchor` returns a cleanup from its callback ref only on React 19 and later, so React 18 no longer logs "Unexpected return value from a callback ref".
  - `useViewAnchor` resends `{ visible: false }` on unmount when the last hidden placement was rejected by `publish`. The core does not retry a rejected hidden placement on its own (a hidden anchor observes nothing); calling `update()` resends it.
  - `SizeMeasurement.extent` is documented as the target's border-box size (content-box where the browser reports no border box), matching the implementation.

## 0.2.2

### Patch Changes

- 69a947d: Add an optional `signal` (`AbortSignal`) to the creators that own DOM observers or scheduled work. An already-aborted signal starts no work, and aborting later is equivalent to calling `dispose()`. README, docs, and package metadata now describe measuring DOM bounds without assuming Electron or a particular transport.

## 0.2.2-alpha.0

### Patch Changes

- a64c35d: Test the Changesets and npm Trusted Publishing workflow end to end with an alpha prerelease. No functional change.
