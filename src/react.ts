import { useCallback, useEffect, useRef } from 'react'
import {
  createPlacementAnchor,
  createViewAnchor,
  type PlacementAnchorHandle,
  type PlacementAnchorOptions,
} from './view-anchor.js'
import type {
  Bounds,
  ViewAnchorHandle,
  ViewAnchorOptions,
} from './types.js'

export interface UseViewAnchorOptions extends ViewAnchorOptions {
  /**
   * Values that re-apply the anchor when changed. Keep this array's length
   * stable across renders.
   */
  deps?: ReadonlyArray<unknown>
}

/** Compatible with React 18's null callback and React 19's ref cleanup. */
export type ViewAnchorRef = (el: HTMLElement | null) => void | (() => void)

export interface UsePlacementAnchorOptions extends PlacementAnchorOptions {
  /**
   * Values that re-apply the anchor when changed. Keep this array's length
   * stable across renders.
   */
  deps?: ReadonlyArray<unknown>
}

/** Callback ref for the explicit-visibility Placement API. */
export type PlacementAnchorRef = ViewAnchorRef

type AnchorHandle = { dispose(): void }

interface LifecycleAdapter<Options, Handle extends AnchorHandle> {
  create(target: HTMLElement, options: Options): Handle
  update(handle: Handle, options: Options): void
  collapse(handle: Handle, options: Options): void
  isCollapsed(options: Options): boolean
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
  // eslint-disable-next-line react-hooks/refs
  optionsRef.current = options
  const adapterRef = useRef(adapter)
  // eslint-disable-next-line react-hooks/refs
  adapterRef.current = adapter
  const appliedRef = useRef(applied)
  const currentAppliedRef = useRef(applied)
  // eslint-disable-next-line react-hooks/refs
  currentAppliedRef.current = applied
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
    const alreadyCollapsed = adapter.isCollapsed(lastAppliedOptionsRef.current)
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

  const ref = useCallback<ViewAnchorRef>((element) => {
    if (element === elementRef.current) {
      cancelPendingDetach()
      return element ? () => deferDetach(element) : undefined
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
      return () => deferDetach(element)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers only read stable refs
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, applied)

  useEffect(() => {
    cancelPendingDetach()
    return () => {
      const element = elementRef.current
      if (element) deferDetach(element)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers only read stable refs
  }, [])

  return ref
}

const viewAdapter: LifecycleAdapter<ViewAnchorOptions, ViewAnchorHandle> = {
  create: createViewAnchor,
  update(handle, options) {
    handle.update(options)
  },
  collapse(handle, options) {
    handle.update({ present: false, publish: options.publish })
  },
  isCollapsed(options) {
    return !options.present
  },
}

/** Bind zero-bounds visibility to a DOM element callback ref. */
export function useViewAnchor(options: UseViewAnchorOptions): ViewAnchorRef {
  return useAnchorRef(
    options,
    [options.present, options.publish, ...(options.deps ?? [])],
    viewAdapter,
  )
}

const placementAdapter: LifecycleAdapter<
  PlacementAnchorOptions,
  PlacementAnchorHandle
> = {
  create: createPlacementAnchor,
  update(handle, options) {
    // In React, an omitted option represents "off" for that render,
    // rather than keeping the previous value.
    handle.update({
      ...options,
      guardDisplayNone: options.guardDisplayNone ?? false,
      followScroll: options.followScroll ?? false,
      followGeometry: options.followGeometry ?? false,
    })
  },
  collapse(handle, options) {
    handle.update({ ...options, visible: false })
  },
  isCollapsed(options) {
    return !options.visible
  },
}

/** Bind the explicit Placement API to a DOM element callback ref. */
export function usePlacementAnchor(
  options: UsePlacementAnchorOptions,
): PlacementAnchorRef {
  return useAnchorRef(
    options,
    [
      options.visible,
      options.publish,
      options.guardDisplayNone,
      options.followScroll,
      options.followGeometry,
      ...(options.deps ?? []),
    ],
    placementAdapter,
  )
}

export type { Bounds }
