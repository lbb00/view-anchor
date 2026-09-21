import { useCallback, useEffect, useInsertionEffect, useMemo, useRef, version } from 'react'
import { createViewAnchor, type ViewAnchorHandle } from './view-anchor.js'
import type { ViewAnchorOptions } from './view-anchor.js'
import { createSizeAnchor } from './size-anchor.js'
import type { SizeAnchorOptions, SizeAnchorHandle, SizeAxis, SizeMeasurement } from './types.js'

export type { SizeAnchorOptions, SizeAnchorHandle, SizeAxis, SizeMeasurement }

export interface UseViewAnchorOptions extends ViewAnchorOptions {
  /**
   * Values that re-apply the anchor when changed. Keep this array's length
   * stable across renders.
   */
  deps?: ReadonlyArray<unknown>
}

/** Compatible with React 18's null callback and React 19's ref cleanup. */
type AnchorRef = (el: HTMLElement | null) => void | (() => void)

/** Callback ref with an imperative trigger for geometry changes React cannot observe. */
export type ViewAnchorRef = AnchorRef & { pulse(durationMs?: number): void }

type AnchorHandle = { dispose(): void }

interface LifecycleAdapter<Options, Handle extends AnchorHandle> {
  create(target: HTMLElement, options: Options): Handle
  update(handle: Handle, options: Options): void
  collapse(handle: Handle, options: Options): void
  isCollapsed(handle: Handle, options: Options): boolean
  /**
   * If this returns true, the handle must be disposed and recreated instead
   * of calling update(). Used when a fundamental option (like axis) changes.
   */
  shouldRecreate?(prevOptions: Options, nextOptions: Options): boolean
}

// Callback refs own the imperative anchor because React invokes them during commit.
// React 19 may call the cleanup returned from a ref and immediately reattach the
// same element in development mode. Collapse is deferred by one microtask so that
// immediate reattachment cancels the collapse.
function useAnchorRef<Options, Handle extends AnchorHandle>(
  options: Options,
  applied: ReadonlyArray<unknown>,
  adapter: LifecycleAdapter<Options, Handle>,
): { ref: AnchorRef; handleRef: { current: Handle | null } } {
  const handleRef = useRef<Handle | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)
  const optionsRef = useRef(options)
  const adapterRef = useRef(adapter)
  const appliedRef = useRef(applied)
  const currentAppliedRef = useRef(applied)
  // Renders discarded before commit (e.g. suspended transitions) must not
  // update optionsRef. Insertion effects run before callback refs in the same commit.
  useInsertionEffect(() => {
    optionsRef.current = options
    adapterRef.current = adapter
    currentAppliedRef.current = applied
  })
  // Options handed to the adapter on the last create/update call.
  // Tracks applied state across renders where the deps array reference changes.
  const lastAppliedOptionsRef = useRef(options)
  const detachTokenRef = useRef(0)

  const cancelPendingDetach = (): void => {
    detachTokenRef.current++
  }

  const collapseAndDispose = (): void => {
    const handle = handleRef.current
    if (!handle) return
    const adapter = adapterRef.current
    const alreadyCollapsed = adapter.isCollapsed(handle, lastAppliedOptionsRef.current)
    try {
      if (!alreadyCollapsed) adapter.collapse(handle, optionsRef.current)
    } finally {
      handleRef.current = null
      handle.dispose()
    }
  }

  const deferDetach = (element: HTMLElement): void => {
    const token = ++detachTokenRef.current
    queueMicrotask(() => {
      if (detachTokenRef.current !== token || elementRef.current !== element) return
      elementRef.current = null
      collapseAndDispose()
    })
  }

  // React 19 invokes the cleanup returned from a callback ref instead of calling
  // ref(null). React 18 warns about the returned function and still calls ref(null).
  const detachCleanup = (element: HTMLElement): (() => void) | undefined =>
    Number.parseInt(version, 10) >= 19 ? () => deferDetach(element) : undefined

  const ref = useCallback<AnchorRef>((element) => {
    if (element === elementRef.current) {
      cancelPendingDetach()
      return element ? detachCleanup(element) : undefined
    }

    cancelPendingDetach()
    const previous = elementRef.current
    if (handleRef.current) {
      if (element) {
        handleRef.current.dispose()
        handleRef.current = null
      } else if (previous) {
        deferDetach(previous)
        return undefined
      }
    }

    if (element) {
      elementRef.current = element
      handleRef.current = adapterRef.current.create(element, optionsRef.current)
      appliedRef.current = currentAppliedRef.current
      lastAppliedOptionsRef.current = optionsRef.current
      return detachCleanup(element)
    }
    return undefined
  }, [])

  useEffect(() => {
    const previous = appliedRef.current
    const changed =
      applied.length !== previous.length ||
      applied.some((value, index) => !Object.is(value, previous[index]))
    if (!changed) return
    appliedRef.current = applied
    const handle = handleRef.current
    const element = elementRef.current
    if (handle && element) {
      const adapter = adapterRef.current
      const prevOpts = lastAppliedOptionsRef.current
      const nextOpts = optionsRef.current
      // Check if we need to recreate the handle (e.g. axis change in size anchor)
      if (adapter.shouldRecreate?.(prevOpts, nextOpts)) {
        handle.dispose()
        handleRef.current = adapter.create(element, nextOpts)
      } else {
        adapter.update(handle, nextOpts)
      }
      lastAppliedOptionsRef.current = nextOpts
    }
    // oxlint-disable-next-line react/exhaustive-deps
  }, applied)

  useEffect(() => {
    cancelPendingDetach()
    return () => {
      const element = elementRef.current
      if (element) deferDetach(element)
    }
  }, [])

  return { ref, handleRef }
}

// Whether each handle's latest { visible: false } was accepted. The core does
// not retry a rejected hidden placement, so unmount must send it again.
type HideState = { accepted: boolean }
const hideStates = new WeakMap<ViewAnchorHandle, HideState>()

const trackHide = (options: ViewAnchorOptions, state: HideState): ViewAnchorOptions => ({
  ...options,
  publish(placement) {
    if (placement.visible) return options.publish(placement)
    state.accepted = false
    const result = options.publish(placement)
    state.accepted = result !== false
    return result
  },
})

const viewAdapter: LifecycleAdapter<ViewAnchorOptions, ViewAnchorHandle> = {
  create(target, options) {
    const state: HideState = { accepted: false }
    const handle = createViewAnchor(target, trackHide(options, state))
    hideStates.set(handle, state)
    return handle
  },
  update(handle, options) {
    // Options are forwarded as-is; the hook applies the same "omitted resets
    // to default" rule as the core's update().
    handle.update(trackHide(options, hideStates.get(handle)!))
  },
  collapse(handle, options) {
    handle.update(trackHide({ ...options, visible: false }, hideStates.get(handle)!))
  },
  isCollapsed(handle, options) {
    return !options.visible && hideStates.get(handle)!.accepted
  },
}

/** Bind the explicit Placement API to a DOM element callback ref. */
export function useViewAnchor(options: UseViewAnchorOptions): ViewAnchorRef {
  const { ref: attach, handleRef } = useAnchorRef(
    options,
    [
      options.visible,
      options.publish,
      options.treatZeroAreaAsHidden,
      options.followScroll,
      options.followGeometry,
      options.dedupe,
      ...(options.deps ?? []),
    ],
    viewAdapter,
  )
  const pulse = useCallback(
    (durationMs?: number) => handleRef.current?.pulse(durationMs),
    [handleRef],
  )
  // The new callback captures the handle, but only reads it when pulse() is called.
  return useMemo(
    // oxlint-disable-next-line react/refs
    () => Object.assign((element: HTMLElement | null) => attach(element), { pulse }),
    [attach, pulse],
  )
}

// ─────────────────────────────────────────────────────────────────────
// useSizeAnchor — React hook for createSizeAnchor
// ─────────────────────────────────────────────────────────────────────

export interface UseSizeAnchorOptions extends Omit<SizeAnchorOptions, 'signal'> {
  /**
   * Values that re-apply the anchor when changed. Keep this array's length
   * stable across renders.
   */
  deps?: ReadonlyArray<unknown>
}

/** Compatible with React 18's null callback and React 19's ref cleanup. */
export type SizeAnchorRef = AnchorRef

const sizeAdapter: LifecycleAdapter<Omit<SizeAnchorOptions, 'signal'>, SizeAnchorHandle> = {
  create(target, options) {
    return createSizeAnchor(target, options)
  },
  update(handle, options) {
    // Options are forwarded as-is; the hook applies the same "omitted resets
    // to default" rule as the core's update().
    handle.update(options)
  },
  collapse(_handle, _options) {
    // Size anchors do not have a "hidden" state to collapse to; they simply
    // stop publishing when disposed. No action needed here.
  },
  isCollapsed(_handle, _options) {
    // Size anchors are never in a "collapsed" state that needs to be sent
    // before unmount; always return true to skip the collapse call.
    return true
  },
  shouldRecreate(prevOptions, nextOptions) {
    // axis is frozen at creation; changing it requires a new handle
    return prevOptions.axis !== nextOptions.axis
  },
}

/**
 * Bind a size anchor to a DOM element callback ref. Reports the target's
 * content size on the specified axis back to the provided publish callback.
 */
export function useSizeAnchor(options: UseSizeAnchorOptions): SizeAnchorRef {
  return useAnchorRef(
    options,
    [options.axis, options.publish, options.dedupe, ...(options.deps ?? [])],
    sizeAdapter,
  ).ref
}
