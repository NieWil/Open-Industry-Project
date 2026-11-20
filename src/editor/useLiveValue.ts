import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { EditorState, EditorStore } from './store/store'

/**
 * Read a slice of editor state that tracks live transient updates (a gizmo drag, a PLC-driven
 * param change mid-run, a manipulator slew) without re-rendering the whole panel each frame.
 *
 * This follows a classic inspector refresh strategy: a throttled poll (an auto-refresh-interval
 * timer) plus a per-property update that skips unchanged fields (a validity cache). Here:
 *  - we subscribe to the store's view stream (`subscribeView`), the one that fires on every
 *    transient - the React stream (`subscribe`) skips them for perf;
 *  - we coalesce that notification burst through requestAnimationFrame, so a 144fps drag or a
 *    per-tick sim slew collapses to at most one React update per frame;
 *  - `select` keeps each call site reading only its own slice, so only the fields whose value
 *    actually changed re-render - the rest early-out on the equality check.
 *
 * `isEqual` defaults to Object.is, which is correct when `select` returns a primitive or a stable
 * object reference (e.g. a scene part object, unchanged until the scene changes). If a selector
 * derives a fresh object/tuple each call, pass a structural comparator - otherwise the snapshot
 * reference changes every read and useSyncExternalStore re-renders in a loop.
 */
export function useLiveValue<T>(
  store: EditorStore,
  select: (s: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // keep the latest closures without re-subscribing (subscribe/getSnapshot identity stays stable)
  const selectRef = useRef(select)
  const isEqualRef = useRef(isEqual)
  selectRef.current = select
  isEqualRef.current = isEqual

  // memoize the selected value so useSyncExternalStore sees a stable reference between unchanged
  // reads (it calls getSnapshot during render and on every commit to detect tearing)
  const last = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback((): T => {
    const next = selectRef.current(store.getState())
    const prev = last.current
    if (prev && isEqualRef.current(prev.value, next)) return prev.value
    last.current = { value: next }
    return next
  }, [store])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let raf = 0
      const flush = () => {
        raf = 0
        onStoreChange()
      }
      const unsub = store.subscribeView(() => {
        if (raf) return // a flush is already queued for this frame - coalesce into it
        raf = requestAnimationFrame(flush)
      })
      return () => {
        if (raf) cancelAnimationFrame(raf)
        unsub()
      }
    },
    [store],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
