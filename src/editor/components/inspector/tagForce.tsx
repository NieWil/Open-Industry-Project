// --- TagForce: the tag's live value and Force / Release beside a tag field, while the program runs ---
// A force is run state held by the controller (EditorController.forcePlcValue): it never writes the document, so
// nothing here commits to the store or adds an undo step. The tag field beside it stays the wiring.

import { useContext, useEffect, useMemo, useState } from 'react'
import type { TagValue } from '../../../plc'
import { forceKeyOf, usePlcForces, type ForceSource } from '../../program/plcForces'
import { declaredTypeSets, formatPlcValue, typeOfKey } from '../../program/plcValueText'
import { TagSourcesContext } from './tagField'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.tagForce', {
  force: 'Force',
  forceTitle: 'Hold {tag} at its value until released. The program reads it and the parts see it, whatever the program writes',
  release: 'Release',
  releaseTitle: 'Give {tag} back to the program from its next scan',
  forcedAt: 'Forced: {value}',
  heldAt: 'Held at {value} until released. The program reads it and the parts see it, whatever the program writes',
  toggleHeld: 'Held at {value}. Click to hold the opposite',
  editHeld: 'Held at {value}. Click to hold a new value',
  newValue: 'New value to hold {tag} at',
  liveTitle: '{tag} is {value} now, as the program holds it',
})

/** How often the live value is read: the Inspector's live-setpoint cadence (Inspector.tsx useLiveSetpoints). */
const LIVE_MS = 120

/**
 * The value the running program holds for `key` (a watch key, forceKeyOf), polled: the watch image changes every
 * scan, independent of any store update. A value that holds still sets the same state, so it re-renders nothing.
 */
function useLiveValue(forcing: TagForcing, key: string | null): TagValue | undefined {
  const [value, setValue] = useState<TagValue | undefined>(() => (key !== null ? forcing.plcWatch?.[key] : undefined))
  useEffect(() => {
    if (key === null) {
      setValue(undefined)
      return
    }
    const read = (): void => setValue(forcing.plcWatch?.[key])
    read()
    const id = setInterval(read, LIVE_MS)
    return () => clearInterval(id)
  }, [forcing, key])
  return value
}

/** What a tag field needs of the controller to force the variable its tag names. */
export interface TagForcing extends ForceSource {
  readonly plcWatch: Readonly<Record<string, TagValue>> | null
  /** The part of plcWatch a force reaches: the program running here, without an external PLC's tags. */
  readonly plcProgramWatch: Readonly<Record<string, TagValue>> | null
  readonly plcAliases: ReadonlyMap<string, string>
  forcePlcValue(key: string, text?: string): string | null
  releasePlcForces(key?: string): void
  onProgramStatus(cb: () => void): () => void
}

/**
 * The live value of the program variable `tag` names, then its Force / Release button, with a FORCED badge in place
 * of the value while it is held. The value is what tells a user the binding is live: a sensor's tag flips as cargo
 * passes, a speed tag reads what the program commands. Nothing when the program is not running or the tag is no
 * program variable (forceKeyOf). The force state re-renders when a force is set or released and when the program
 * attaches or detaches; the value is polled (useLiveValue).
 */
export function TagForce({ forcing, tag, paramKey }: { forcing: TagForcing; tag: string; paramKey: string }) {
  const forces = usePlcForces(forcing)
  const [, setStatusTick] = useState(0)
  useEffect(() => forcing.onProgramStatus(() => setStatusTick((n) => n + 1)), [forcing])
  const [error, setError] = useState<string | null>(null)
  // the held number being typed (Enter holds it; Escape or leaving the field holds nothing new)
  const [draft, setDraft] = useState<string | null>(null)
  const source = useContext(TagSourcesContext)?.check.source
  const watch = forcing.plcWatch
  const key = forceKeyOf(tag, watch, forcing.plcAliases)
  const held = key !== null ? forces[key] : undefined
  const isHeld = held !== undefined
  const live = useLiveValue(forcing, watch ? key : null)
  // the declarations are parsed once per program while it runs, to show a duration or a date in its literal
  const running = watch !== null
  const types = useMemo(() => (running && source ? declaredTypeSets(source) : null), [running, source])
  if (!watch || key === null) return null
  // a STRING cannot be forced (the Watch dock offers no Force for one either)
  const value = watch[key]
  if (!isHeld && (value === undefined || typeof value === 'string')) return null
  // an external PLC's tag shows its value, but a force here would never reach that PLC
  const forceable = isHeld || forceKeyOf(tag, forcing.plcProgramWatch, forcing.plcAliases) === key
  const liveText = !isHeld && live !== undefined && typeof live !== 'string' ? formatPlcValue(live, types ? typeOfKey(types, key) : undefined, 8) : null
  const heldTip = isHeld ? t(M.heldAt, { value: formatPlcValue(held, types ? typeOfKey(types, key) : undefined) }) : undefined
  return (
    <span className={`tag-force${isHeld ? ' on' : ''}`} title={heldTip}>
      {/* held, the force takes a line of its own under the field (inspector.css), so the tag stays readable. The badge
          changes the held value, as a forced row of the Watch dock does: a BOOL flips on a click, a number opens a field */}
      {isHeld && draft !== null && (
        <input
          className="tag-forced-input"
          data-testid="inspector-forced-input"
          aria-label={t(M.newValue, { tag })}
          spellCheck={false}
          autoFocus
          value={draft}
          size={Math.max(4, draft.length + 1)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const why = forcing.forcePlcValue(key, draft)
              setError(why)
              if (why === null) setDraft(null)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
              setError(null)
            }
          }}
        />
      )}
      {isHeld && draft === null && (
        <button
          type="button"
          className="tag-forced-badge"
          data-testid="inspector-forced"
          title={t(typeof held === 'boolean' ? M.toggleHeld : M.editHeld, { value: formatPlcValue(held, types ? typeOfKey(types, key) : undefined) })}
          onClick={() => {
            if (typeof held === 'boolean') setError(forcing.forcePlcValue(key, String(!held)))
            else {
              setError(null)
              setDraft(String(held))
            }
          }}
        >
          {t(M.forcedAt, { value: formatPlcValue(held, types ? typeOfKey(types, key) : undefined) })}
        </button>
      )}
      {liveText !== null && (
        <span className="tag-live" data-testid="inspector-live-value" title={t(M.liveTitle, { tag, value: liveText })}>
          {liveText}
        </span>
      )}
      {forceable && <button
        type="button"
        className="tag-force-btn"
        data-testid={`inspector-force-${paramKey}`}
        aria-pressed={isHeld}
        title={isHeld ? `${t(M.releaseTitle, { tag })}\n${heldTip}` : t(M.forceTitle, { tag })}
        onClick={() => {
          if (isHeld) {
            forcing.releasePlcForces(key)
            setError(null)
          } else setError(forcing.forcePlcValue(key))
        }}
      >
        {t(isHeld ? M.release : M.force)}
      </button>}
      {error && (
        <span className="tag-warn" role="alert" title={error} aria-label={error} data-testid="inspector-force-error">
          {'!' /* i18n-ok: a mark, its words are the title */}
        </span>
      )}
    </span>
  )
}
