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
   * Values that must re-apply the current anchor when they change. Keep this
   * array's length stable across renders, as required by React effect deps.
   */
  deps?: ReadonlyArray<unknown>
}

/** Compatible with React 18's null callback and React 19's ref cleanup. */
export type ViewAnchorRef = (el: HTMLElement | null) => void | (() => void)

export interface UsePlacementAnchorOptions extends PlacementAnchorOptions {
  /**
   * Values that must re-apply the current anchor when they change. Keep this
   * array's length stable across renders, as required by React effect deps.
   */
  deps?: ReadonlyArray<unknown>
}

/** A callback ref for the explicit-visibility Placement API. */
export type PlacementAnchorRef = ViewAnchorRef

type AnchorHandle = { dispose(): void }

interface LifecycleAdapter<Options, Handle extends AnchorHandle> {
  create(target: HTMLElement, options: Options): Handle
  update(handle: Handle, options: Options): void
  collapse(handle: Handle, options: Options): void
  isCollapsed(options: Options): boolean
}

// Callback refs own the imperative anchor because React invokes them during
// commit, before passive effects. React 19 may call the cleanup returned from
// a ref and immediately attach that same element again to replay lifecycles in
// development. A real detach and that replay are indistinguishable at cleanup
// time, so collapse is deferred by one microtask: a same-turn reattach cancels
// it, while a real disappearance is hidden and disposed before the next task.
function useAnchorRef<Options, Handle extends AnchorHandle>(
  options: Options,
  applied: ReadonlyArray<unknown>,
  adapter: LifecycleAdapter<Options, Handle>,
): ViewAnchorRef {
  const handleRef = useRef<Handle | null>(null)
  const elementRef = useRef<HTMLElement | null>(null)
  const optionsRef = useRef(options)
  // The ref callback runs in commit before effects; it must see this render's
  // options when a previously absent element attaches.
  // eslint-disable-next-line react-hooks/refs
  optionsRef.current = options
  const adapterRef = useRef(adapter)
  // eslint-disable-next-line react-hooks/refs
  adapterRef.current = adapter
  const appliedRef = useRef(applied)
  const currentAppliedRef = useRef(applied)
  // eslint-disable-next-line react-hooks/refs
  currentAppliedRef.current = applied
  // Options actually handed to the adapter by the last create/update call.
  // `applied` is a fresh array on every render even when its values are
  // unchanged, so array identity cannot tell "already applied" from "not yet
  // applied" — this ref tracks the real applied state instead.
  const lastAppliedOptionsRef = useRef(options)
  const detachTokenRef = useRef(0)

  const cancelPendingDetach = (): void => {
    detachTokenRef.current++
  }

  const collapseAndDispose = (): void => {
    const handle = handleRef.current
    if (!handle) return
    const adapter = adapterRef.current
    // A same-commit visibility effect may already have published the collapse
    // before this deferred ref cleanup runs.
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
      // React 19's cleanup → same-element reattach replay lands here.
      cancelPendingDetach()
      return element ? () => deferDetach(element) : undefined
    }

    cancelPendingDetach()
    const previous = elementRef.current
    if (handleRef.current) {
      if (element) {
        // A → B is a live swap: the new anchor synchronously publishes its
        // real Placement, so do not flicker through a hidden value.
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
    // `applied` is deliberately caller-built and may contain a stable-length
    // deps array, matching React's documented dynamic dependency pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, applied)

  useEffect(() => {
    // StrictMode effect replay also has a cleanup/setup pair. Its setup runs
    // before the queued microtask and therefore cancels that throwaway cleanup.
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

/** Bind legacy zero-bounds visibility to a DOM element callback ref. */
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
    // `handle.update` treats an omitted flag as "keep current value" (see
    // `createPlacementAnchor`'s JSDoc), but a React options object is the
    // caller's full current intent for this render — an omitted flag here
    // must mean "off", matching every other declarative React prop.
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

/**
 * Bind the explicit Placement API to a DOM element callback ref. `pulse()` is
 * intentionally imperative-only: a ref callback has no natural call site for
 * a one-off animation request, while `followScroll`/`followGeometry` cover
 * continuous DOM-driven motion declaratively.
 */
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
