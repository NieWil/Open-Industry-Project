// --- field primitives (RevertButton / SpinSlider / NumberField / AxisInput / VectorRow / TextField / BoolRow / Fold) ---

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { clamp } from '../../../core/math'
import { isRealBound, isRealRange } from '../../../core/packageParams'
import { displayUnitFor, METRIC_DISPLAY, niceStep, toStored, unitView, type DisplayUnits } from '../../../core/units'
import { evalNumeric, parseOffset, snapToStep } from './shared'
import { FoldIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.fields', {
  revert: 'Revert to default',
  increase: 'Increase',
  decrease: 'Decrease',
  bit: 'Bit {i} ({value})',
})

/** per-property revert arrow, shown when a value differs from its default */
export function RevertButton({ onClick, title = t(M.revert) }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" className="field-revert" title={title} aria-label={title} onClick={onClick}>
      ⟲
    </button>
  )
}

/**
 * The revert arrow's space when there is nothing to revert. A row always holds one or the other, so the arrow
 * appearing as you edit (or a run hiding it) never narrows the field under the cursor, and every row's control ends
 * at the same edge.
 */
export function RevertSlot() {
  return <span className="field-revert-slot" aria-hidden="true" />
}

/** Brackets a field's continuous gesture (a slide, a held spin arrow or arrow key) so its per-step commits stream as one live
 *  edit (store.beginLiveEdit): no React render, autosave or pool / bundle rebuild per step. The Inspector
 *  provides it; a field outside one commits every step as before. */
export interface LiveEditGate {
  begin(): void
  end(): void
}
export const LiveEditContext = createContext<LiveEditGate | null>(null)

/** The scene's Speed and Length (core/scene/sceneUnits.ts), as fields show them. The Inspector provides it; a field
 *  outside one shows metric, which is what everything is stored in. */
export const DisplayUnitsContext = createContext<DisplayUnits>(METRIC_DISPLAY)

/** Whether guard-openings mode (G) is on, so the Guard openings table's button can say "Done editing" while it is. */
export const GuardOpeningsModeContext = createContext(false)

/** The unit a metre value is shown in right now ('m' or 'in'), for a row label that names it ("Position (in)"). */
export function useShownLengthUnit(): string {
  return displayUnitFor('m', useContext(DisplayUnitsContext))
}

// A press that moves this far is a slide, not a click (a click places the caret to type)
const GRAB_THRESHOLD_PX = 4

interface SpinSliderProps {
  value: number
  decimals: number
  /** unit shown as a suffix inside the field (`suffix:m`), and the unit typed input converts into; '' for none */
  unit?: string
  /** the unit typed input converts into when the field shows no suffix (a compact Transform axis: Position is m) */
  entryUnit?: string
  min?: number
  max?: number
  step?: number
  disabled: boolean
  /** multi-edit: the selected parts disagree, so show a blank/indeterminate field */
  mixed?: boolean
  /** narrow variant for Transform x/y/z (tighter sizing, same chrome) */
  compact?: boolean
  onCommit: (v: number) => void
  /** a relative entry ("+= 1.2"), in the stored unit. Without it the field commits its value plus the offset,
   *  which a mixed field can't do; a field over several parts passes this to offset each part from its own value. */
  onOffset?: (d: number) => void
}

/**
 * A number field. What it does depends on what it holds:
 *  - Every field is typed: a click places the caret, and the value commits on Enter, Tab or leaving the field
 *    (Escape puts back what it held). Nothing is written while typing, so "12" never builds a 1 first. The text
 *    may be an expression ("2*0.75") or carry a unit the field converts ("5ft", "394 fpm"; see evalNumeric).
 *    "+=" or "-=" in front makes it an offset from the current value ("+= 600mm"; see parseOffset).
 *  - Every field steps on the grid with ArrowUp/Down and the hover spin arrows (press and hold repeats).
 *  - A field with a real range (isRealRange: both bounds chosen, not the ±1e6 stand-in) is also a slider: its
 *    fill shows where the value sits, and dragging across it moves the value in proportion to the range, the
 *    field's width covering all of it (Shift = a tenth as fast; Escape mid-drag puts the value back). An
 *    open-ended value (a length, a position) has no sensible drag rate, so it doesn't drag: its continuous
 *    control is the part's viewport handle.
 * Steps and slides stream as one live edit (LiveEditContext) and land as one undo step on release.
 *
 * A length or speed shows in the viewer's display units (DisplayUnitsContext): the props stay in the stored unit,
 * and this converts the value, range and step in and every commit back out, so no caller knows the difference.
 */
export function SpinSlider(props: SpinSliderProps) {
  const system = useContext(DisplayUnitsContext)
  const { unit, entryUnit, value, min, max, step, decimals, onCommit, onOffset } = props
  const view = unitView(unit || entryUnit || '', system)
  if (view.k === 1) return <SpinSliderCore {...props} />
  const k = view.k
  // a bound the schema left out (the ±1e6 stand-in) stays one, whatever the factor would make of it
  const bound = (b: number | undefined): number | undefined => (b === undefined || !isRealBound(b) ? b : b * k)
  return (
    <SpinSliderCore
      {...props}
      value={value * k}
      min={bound(min)}
      max={bound(max)}
      step={step !== undefined && step > 0 ? niceStep(step * k) : step}
      decimals={view.decimals ?? decimals}
      unit={unit ? view.unit : unit}
      entryUnit={entryUnit ? view.unit : entryUnit}
      onCommit={(v) => onCommit(toStored(v, k))}
      onOffset={onOffset && ((d) => onOffset(toStored(d, k)))}
    />
  )
}

function SpinSliderCore({ value, decimals, unit = '', entryUnit, min, max, step, disabled, mixed, compact, onCommit, onOffset }: SpinSliderProps) {
  // the unit is drawn as a separate dim suffix, never part of the editable text
  const fmt = (v: number): string => v.toFixed(decimals)
  const [text, setText] = useState(mixed ? '' : fmt(value))
  // The handlers read the text through this ref, never the render's `text`: Enter and Escape blur the input
  // from inside keydown, and a spin arrow steps before the input loses focus, so the blur handler that runs
  // is always one render behind whatever was just shown.
  const textRef = useRef(text)
  const show = (t: string): void => {
    textRef.current = t
    setText(t)
  }
  const focused = useRef(false)
  // One edit session, focus to blur: what the field showed and held when it took focus, whether the field
  // was mixed then, and whether the session has already written (arrow steps).
  const session = useRef({ text: '', value, mixed: false, wrote: false })
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLSpanElement>(null)
  // A live edit (LiveEditContext) keeps the Inspector from re-rendering per step, so `value` holds still for the
  // gesture: the field shows and steps from its own last commit instead.
  const liveGate = useContext(LiveEditContext)
  const [liveValue, setLiveValue] = useState<number | null>(null)
  const live = useRef(false)
  const beginLive = (): void => {
    if (live.current) return
    live.current = true
    liveGate?.begin()
  }
  const endLive = (): void => {
    if (!live.current) return
    live.current = false
    liveGate?.end() // the store's catch-up render brings the committed value back in as `value`
    setLiveValue(null)
  }
  const shownValue = liveValue ?? value
  // latest value for the auto-repeat timer (closures would otherwise capture a stale prop)
  const valueRef = useRef(shownValue)
  valueRef.current = shownValue

  useEffect(() => {
    if (!focused.current) show(mixed ? '' : fmt(shownValue))
  }, [shownValue, decimals, unit, mixed])

  const stp = step !== undefined && step > 0 ? step : 0.001
  const ranged = isRealRange(min, max)
  const slider = ranged && !mixed && !disabled
  const fill = ranged && !mixed ? clamp((shownValue - min!) / (max! - min!), 0, 1) : 0

  const clampVal = (v: number): number => {
    let nv = v
    if (min !== undefined) nv = Math.max(min, nv)
    if (max !== undefined) nv = Math.min(max, nv)
    return nv
  }
  const commitRaw = (v: number): void => {
    const nv = clampVal(v)
    if (!Number.isFinite(nv)) return
    onCommit(nv)
    if (live.current) {
      valueRef.current = nv
      setLiveValue(nv)
    }
  }
  // an arrow-key or spin-arrow step: while the field has focus it must also show the step and adopt it as
  // the session's text, or the blur that follows writes the old text back over it
  const stepBy = (dir: 1 | -1): void => {
    const nv = clampVal(snapToStep(valueRef.current + dir * stp, stp))
    if (!Number.isFinite(nv)) return
    commitRaw(nv)
    if (!focused.current) return
    session.current.text = fmt(nv)
    session.current.wrote = true
    show(session.current.text)
  }

  // ── slide (ranged fields only) ──
  // x = last clientX; dist = accumulated drag in px (Shift-scaled); width = the field's, which spans the range
  const slide = useRef<{ x: number; start: number; width: number; dist: number; sliding: boolean } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (!slider || e.button !== 0 || focused.current) return // editing: the pointer places the caret / selects
    // No focus yet: a press may become a slide, and focusing would select the text (a later move then drags
    // the selection). A press that doesn't move focuses on release instead, which is the click-to-type.
    e.preventDefault()
    const width = boxRef.current?.getBoundingClientRect().width ?? 0
    slide.current = { x: e.clientX, start: valueRef.current, width: Math.max(width, 1), dist: 0, sliding: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // a pointer the browser no longer considers active: the drag still works while it stays over the field
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const d = slide.current
    if (!d) return
    let dx = e.clientX - d.x
    d.x = e.clientX
    if (e.shiftKey && d.sliding) dx *= 0.1 // Shift = fine (0.1x)
    d.dist += dx
    if (!d.sliding) {
      if (Math.abs(d.dist) <= GRAB_THRESHOLD_PX) return
      d.sliding = true
      beginLive()
    }
    commitRaw(snapToStep(d.start + (d.dist / d.width) * (max! - min!), stp))
  }
  const endSlide = (e: ReactPointerEvent<HTMLInputElement>, click: boolean) => {
    const d = slide.current
    slide.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d) return
    if (d.sliding) endLive()
    else if (click) inputRef.current?.focus()
  }
  // Escape mid-slide puts the value back. Caught at the window ahead of the editor's own Escape (deselect),
  // through a ref so the listener registered once always runs this render's handler.
  const onSlideEscape = useRef<(e: KeyboardEvent) => void>(() => {})
  onSlideEscape.current = (e) => {
    const d = slide.current
    if (e.key !== 'Escape' || !d?.sliding) return
    e.preventDefault()
    e.stopPropagation()
    slide.current = null
    commitRaw(d.start)
    endLive()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => onSlideEscape.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // spin arrows: immediate step on press, then auto-repeat while held
  const hold = useRef<{ delay?: ReturnType<typeof setTimeout>; rep?: ReturnType<typeof setInterval> }>({})
  const stopHold = () => {
    if (hold.current.delay) clearTimeout(hold.current.delay)
    if (hold.current.rep) clearInterval(hold.current.rep)
    hold.current = {}
    endLive()
  }
  const startHold = (dir: 1 | -1) => {
    const stepOnce = () => stepBy(dir)
    beginLive()
    stepOnce()
    hold.current.delay = setTimeout(() => {
      hold.current.rep = setInterval(stepOnce, 60)
    }, 300)
  }
  // unmount mid-gesture (the selection changed under a held arrow): close the live edit so the store catches up
  useEffect(() => stopHold, [])

  const arrow = (dir: 1 | -1, cls: string, glyph: string) => (
    <button
      type="button"
      className={cls}
      tabIndex={-1}
      aria-label={t(dir > 0 ? M.increase : M.decrease)}
      disabled={disabled}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (e.button === 0) startHold(dir)
      }}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
    >
      {glyph}
    </button>
  )

  return (
    <span ref={boxRef} className={`spin${slider ? ' spin-slider' : ''}${compact ? ' spin-compact' : ''}${disabled ? ' spin-disabled' : ''}`}>
      {ranged && !mixed && <span className="spin-fill" style={{ width: `${fill * 100}%` }} />}
      {/* the slider's grabber: rides the fill edge of a real range */}
      {ranged && !mixed && <span className="spin-grabber" style={{ left: `${fill * 100}%` }} />}
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        className="spin-input"
        value={text}
        placeholder={mixed ? '--' : undefined}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endSlide(e, true)}
        onPointerCancel={(e) => endSlide(e, false)}
        onFocus={(e) => {
          focused.current = true
          const shown = mixed ? '' : fmt(value)
          session.current = { text: shown, value, mixed: !!mixed, wrote: false }
          show(shown)
          requestAnimationFrame(() => {
            if (focused.current) e.target.select()
          })
        }}
        onBlur={() => {
          focused.current = false
          endLive() // arrow keys held when focus left
          // An untouched field is never written: its text is the value rounded for display, so committing it
          // back would quietly change the value (and take an undo step) just for clicking in and out.
          if (textRef.current === session.current.text) {
            show(mixed ? '' : fmt(value))
            return
          }
          const offset = parseOffset(textRef.current, unit || entryUnit || '')
          if (offset !== undefined) {
            if (offset !== null && onOffset) onOffset(offset)
            else if (offset !== null && !mixed) commitRaw(valueRef.current + offset)
            else if (session.current.wrote && !session.current.mixed) onCommit(session.current.value)
            show(mixed ? '' : fmt(offset !== null && !onOffset && !mixed ? clampVal(valueRef.current + offset) : session.current.value))
            return
          }
          const parsed = evalNumeric(textRef.current, unit || entryUnit || '')
          if (parsed !== null) commitRaw(parsed)
          // text that doesn't parse ("2 3") is a cancelled edit: undo whatever arrow steps the session wrote
          else if (session.current.wrote && !session.current.mixed) onCommit(session.current.value)
          const shown = parsed !== null ? clampVal(parsed) : session.current.mixed ? value : session.current.value
          show(mixed && parsed === null ? '' : fmt(shown))
        }}
        // typing only edits the text: the value commits on Enter / Tab / blur, never per keystroke
        onChange={(e) => show(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          else if (e.key === 'Escape') {
            // cancel: put back what the field held at focus if this session already wrote, then show the
            // focus-time text so the blur below sees an untouched field and writes nothing
            const s = session.current
            if (s.wrote && !s.mixed) onCommit(s.value)
            show(s.text)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            // a held key auto-repeats: the run of steps is one live edit, closed on key-up (or blur)
            beginLive()
            stepBy(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
        onKeyUp={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') endLive()
        }}
      />
      {unit && !mixed && <span className="spin-unit">{unit}</span>}
      <span className="spin-arrows">
        {arrow(1, 'spin-up', '▲')}
        {arrow(-1, 'spin-down', '▼')}
      </span>
    </span>
  )
}

export interface NumberFieldProps {
  label: string
  unit: string
  value: number
  decimals: number
  min?: number
  max?: number
  step?: number
  disabled: boolean
  mixed?: boolean
  tooltip?: string
  extra?: ReactNode
  /** short tag after the label (e.g. `plc` on a field a running program is commanding) */
  badge?: string
  onCommit: (v: number) => void
}

export function NumberField({ label, unit, value, decimals, min, max, step, disabled, mixed, tooltip, extra, badge, onCommit }: NumberFieldProps) {
  return (
    <label className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {badge && <span className="field-badge">{badge}</span>}
      </span>
      <span className="field-control">
        <SpinSlider
          value={value}
          decimals={decimals}
          unit={unit}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          mixed={mixed}
          onCommit={onCommit}
        />
        {extra}
      </span>
    </label>
  )
}

/**
 * A bitmask number (ParamSpec.bits) as one checkbox per bit, bit 0 first: a stack light's lit tiers read and set as
 * tiers rather than a number to work out by hand. A click toggles one bit (onToggle), so across a mixed selection it
 * sets or clears that bit on each part and leaves their other bits alone; mixed shows every box indeterminate.
 */
export function BitsField({
  label,
  count,
  value,
  mixed,
  tooltip,
  badge,
  disabled,
  extra,
  onToggle,
}: {
  label: string
  count: number
  value: number
  mixed?: boolean
  tooltip?: string
  badge?: string
  disabled: boolean
  extra?: ReactNode
  onToggle: (bit: number, on: boolean) => void
}) {
  const v = Math.max(0, Math.round(value))
  return (
    <div className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {badge && <span className="field-badge">{badge}</span>}
      </span>
      <span className="field-control bits-control">
        {Array.from({ length: count }, (_, i) => (
          <label key={i} className="bits-cell" title={t(M.bit, { i, value: 1 << i })}>
            <input
              type="checkbox"
              checked={!mixed && (v & (1 << i)) !== 0}
              ref={(el) => {
                if (el) el.indeterminate = !!mixed
              }}
              disabled={disabled}
              onChange={(e) => onToggle(i, e.target.checked)}
            />
            <span>{i}</span>
          </label>
        ))}
        {extra}
      </span>
    </div>
  )
}

/** single x/y/z component of a vector row (Transform-style inline spin slider) */
export function AxisInput({
  prefix,
  value,
  decimals,
  step,
  entryUnit,
  disabled,
  mixed,
  onCommit,
  onOffset,
}: {
  prefix: string
  value: number
  decimals: number
  step?: number
  /** see SpinSlider: the unit typed input converts into (the row label names it; the narrow axis shows none) */
  entryUnit?: string
  disabled: boolean
  mixed?: boolean
  onCommit: (v: number) => void
  onOffset?: (d: number) => void
}) {
  return (
    <span className={`axis axis-${prefix.toLowerCase()}`}>
      <span className="axis-label">{prefix}</span>
      <SpinSlider value={value} decimals={decimals} step={step} entryUnit={entryUnit} disabled={disabled} mixed={mixed} compact onCommit={onCommit} onOffset={onOffset} />
    </span>
  )
}

export function VectorRow({
  label,
  tooltip,
  onContext,
  children,
}: {
  label: string
  tooltip?: string
  onContext?: (e: ReactMouseEvent) => void
  children: ReactNode
}) {
  return (
    <div className="field vector-field" onContextMenu={onContext}>
      <span className="field-label" title={tooltip}>
        {label}
      </span>
      <span className="vector-axes">{children}</span>
    </div>
  )
}

export interface TextFieldProps {
  label: string
  value: string
  placeholder?: string
  disabled: boolean
  mixed?: boolean
  tooltip?: string
  extra?: ReactNode
  /** chips after the label (a tag field's direction / clash badges) */
  labelExtra?: ReactNode
  /** id of a <datalist> to suggest from. Picking a suggestion commits at once; typing waits for Enter / blur. */
  list?: string
  /** an identifier, not prose: no spellcheck, no browser autofill */
  code?: boolean
  /** the input's data-testid */
  testid?: string
  onCommit: (v: string) => void
}

export function TextField({ label, value, placeholder, disabled, mixed, tooltip, extra, labelExtra, list, code, testid, onCommit }: TextFieldProps) {
  const [text, setText] = useState(value)
  // read by the handlers instead of `text`, for the same reason as SpinSlider's: Enter / Escape blur from
  // inside keydown, where the render's `text` is one keystroke behind
  const textRef = useRef(text)
  const show = (t: string): void => {
    textRef.current = t
    setText(t)
  }
  const focused = useRef(false)
  // set by a keystroke: a field nobody typed in is never committed (a mixed one would otherwise write its
  // blank placeholder into every selected part just for being clicked)
  const edited = useRef(false)

  useEffect(() => {
    if (!focused.current) show(mixed ? '' : value)
  }, [value, mixed])

  const commit = (t: string): void => {
    if (edited.current && (mixed || t !== value)) onCommit(t)
    edited.current = false
  }

  return (
    <label className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {labelExtra}
      </span>
      <span className="field-control">
        <input
          type="text"
          value={text}
          // the whole value on hover: the box shows only the start of a long one
          title={text || undefined}
          placeholder={mixed ? '--' : placeholder}
          disabled={disabled}
          list={list}
          data-testid={testid}
          spellCheck={code ? false : undefined}
          autoComplete={code ? 'off' : undefined}
          onFocus={() => {
            focused.current = true
            edited.current = false
          }}
          onBlur={() => {
            focused.current = false
            commit(textRef.current)
          }}
          onChange={(e) => {
            show(e.target.value)
            edited.current = true
            // a datalist pick arrives as one replacement rather than as typing: take it now
            const kind = (e.nativeEvent as InputEvent).inputType
            if (list && (kind === undefined || kind === '' || kind === 'insertReplacementText')) commit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') {
              // cancel: back to the stored value, and the blur that follows has nothing to commit
              edited.current = false
              show(mixed ? '' : value)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {extra}
      </span>
    </label>
  )
}

export function BoolRow({
  label,
  checked,
  disabled,
  mixed,
  tooltip,
  extra,
  badge,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  mixed?: boolean
  tooltip?: string
  extra?: ReactNode
  /** short tag after the label (e.g. `plc` on a state a running program is commanding) */
  badge?: string
  onChange: (v: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed
  }, [mixed])
  return (
    <label className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {badge && <span className="field-badge">{badge}</span>}
      </span>
      <span className="field-control">
        <input
          ref={ref}
          type="checkbox"
          checked={mixed ? false : checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {extra}
      </span>
    </label>
  )
}

/** foldable section header + body (group / array / Transform) */
export function Fold({
  title,
  path,
  depth = 0,
  collapsed,
  toggle,
  badge,
  children,
}: {
  title: string
  path: string
  depth?: number
  collapsed: Record<string, boolean>
  toggle: (path: string) => void
  badge?: string | number
  children: ReactNode
}) {
  const isCollapsed = collapsed[path] ?? false
  return (
    <div className={depth === 0 ? 'inspector-group' : 'inspector-subgroup'}>
      <button type="button" className="inspector-group-head" aria-expanded={!isCollapsed} onClick={() => toggle(path)}>
        <span className="inspector-group-caret"><FoldIcon closed={isCollapsed} /></span>
        {title}
        {badge !== undefined && <span className="array-count">{badge}</span>}
      </button>
      {!isCollapsed && <div className="inspector-group-body">{children}</div>}
    </div>
  )
}
