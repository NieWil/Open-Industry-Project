import { useEffect, useState } from 'react'
import type { ComponentType, ReactElement } from 'react'

// A lazy component that opens at once when its chunk is already here.
//
// `React.lazy` + `<Suspense fallback={null}>` still delays the first render even when the chunk was fetched ahead
// of the click. A lazy component suspends on its first render whether or not the module is loaded (the import is
// only started by that render, and its promise settles a microtask later), so the boundary commits its fallback.
// React 19 then throttles the reveal that follows a fallback to 300 ms after it (`globalMostRecentFallbackTime + 300`
// in react-dom, to stop spinners flickering). So with plain `lazy` the first opening of every lazy dialog waits
// 300 ms for nothing: measured on three of the PLC panel's dialogs alike, 340 ms to the first field against 45 ms
// for the second opening. Prefetching does not change it.
//
// This keeps the chunk lazy (the eager-JS budget is why these are chunks at all) and drops the suspension. `preload`
// fetches it and keeps the component, and a mount that finds it kept renders it directly: no boundary, no fallback,
// no throttle. A mount that does not find it renders nothing, fetches, and shows it as soon as it arrives, which is
// what `fallback={null}` showed, without the 300 ms after it.

export interface ReadyLazy<P> {
  /** renders the component; nothing while its chunk is still on the way */
  Component: (props: P) => ReactElement | null
  /** fetch the chunk now (idempotent): on idle, or on hover of whatever opens it */
  preload: () => Promise<void>
}

export function readyLazy<P extends object>(load: () => Promise<ComponentType<P>>): ReadyLazy<P> {
  let loaded: ComponentType<P> | null = null
  let failed: { error: unknown } | null = null
  let pending: Promise<void> | null = null
  const preload = (): Promise<void> =>
    (pending ??= load().then(
      (component) => {
        loaded = component
      },
      (error: unknown) => {
        failed = { error }
      },
    ))

  function Ready(props: P): ReactElement | null {
    // Chosen once per mount: a component that changed type under a mounted dialog would remount it, and its draft with it.
    const [Impl, setImpl] = useState<ComponentType<P> | null>(() => loaded)
    const [broken, setBroken] = useState<{ error: unknown } | null>(null)
    useEffect(() => {
      if (Impl) return
      let live = true
      // preload never rejects: a load failure is kept in `failed` and thrown to the error boundary below
      // eslint-disable-next-line oip/no-unhandled-then
      void preload().then(() => {
        if (!live) return
        if (loaded) setImpl(() => loaded)
        else setBroken(failed)
      })
      return () => {
        live = false
      }
    }, [Impl])
    // a chunk that could not be fetched is the error `lazy` would have thrown, to the same boundary
    if (broken) throw broken.error
    return Impl ? <Impl {...props} /> : null
  }
  return { Component: Ready, preload }
}
