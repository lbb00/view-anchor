import { useCallback, useEffect, useInsertionEffect, useRef, version } from 'react'
import { createViewAnchor, type ViewAnchorHandle } from './view-anchor.js'
import type { ViewAnchorOptions } from './view-anchor.js'

export interface UseViewAnchorOptions extends ViewAnchorOptions {
  /**
   * Values that re-apply the anchor when changed. Keep this array's length
   * stable across renders.
   */
  deps?: ReadonlyArray<unknown>
}

/** Compatible with React 18's null callback and React 19's ref cleanup. */
export type ViewAnchorRef = (el: HTMLElement | null) => void | (() => void)

type AnchorHandle = { dispose(): void }

interface LifecycleAdapter<Options, Handle extends AnchorHandle> {
  create(target: HTMLElement, options: Options): Handle
  update(handle: Handle, options: Options): void
  collapse(handle: Handle, options: Options): void
  isCollapsed(handle: Handle, options: Options): boolean
}

// Callback refs own the imperative anchor because React invokes them during commit.
// React 19 may call the cleanup returned from a ref and immediately reattach the
// same element in development mode. Collapse is deferred by one microtask so that
// immediate reattachment cancels the collapse.
function useAnchorRef<Options, Handle extends AnchorHandle>(
  options: Options,
  applied: ReadonlyArray<unknown>,
  adapter: LifecycleAdapter<Options, Handle>,
): ViewAnchorRef {
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

  const ref = useCallback<ViewAnchorRef>((element) => {
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
    if (handle) {
      adapterRef.current.update(handle, optionsRef.current)
      lastAppliedOptionsRef.current = optionsRef.current
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

  return ref
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
  return useAnchorRef(
    options,
    [
      options.visible,
      options.publish,
      options.treatZeroAreaAsHidden,
      options.followScroll,
      options.followGeometry,
      options.holdSelector,
      options.dedupe,
      ...(options.deps ?? []),
    ],
    viewAdapter,
  )
}
