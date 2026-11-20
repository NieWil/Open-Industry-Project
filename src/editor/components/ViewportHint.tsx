import { useEffect } from 'react'
import type { EditorStore } from '../store/store'

interface ViewportHintProps {
  hint: { key: number; text: string }
  store: EditorStore
  /** walk mode: shown under the crosshair prompt, where the eye already is (the bottom edge holds the controls line) */
  pilot?: boolean
}

/**
 * A transient bottom-center viewport pill for point-of-interaction feedback that has no other
 * channel - e.g. "In auto - PLC controlled" when a C press lands on a device a program owns, or a dock door the
 * walking character tries to shut onto a conveyor. Auto-dismisses; a re-flash (new key) restarts
 * the timer via the effect dependency.
 */
export function ViewportHint({ hint, store, pilot = false }: ViewportHintProps) {
  useEffect(() => {
    const t = window.setTimeout(() => store.dismissViewportHint(hint.key), 2200)
    return () => window.clearTimeout(t)
  }, [hint.key, store])
  return (
    <div className={pilot ? 'viewport-hint viewport-hint-pilot' : 'viewport-hint'} key={hint.key} role="status">
      {hint.text}
    </div>
  )
}
