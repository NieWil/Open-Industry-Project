// --- TagField: a PLC tag's text box, with suggestions from the scene, the program and the connected PLC ---
//
// Still a text box: whatever is typed is the tag, and a suggestion only fills in a name that could have been typed.
// The list is the app's own rather than a <datalist>, because a datalist cannot say where a name comes from, show its
// type, or say that a thousand more PLC tags fit what is typed. A PLC's tags are listed only once something is typed:
// a large program's tree runs to thousands of names, which no one scrolls.
//
// Once the project has a controller besides the default one (`Cell2::%IX0.0`, core/io/controllerTag.ts), the box holds
// the tag without the name. Which controller it is on is said once for the part, by the Controller row above
// (controllerRow.tsx); a picker in front of the box says it per field when the part's tags disagree, or when the part
// has no tag yet. Typing `Cell2::` in the box still works. The program's suggestions are the default controller's, so
// a named controller's tag gets none.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { controllerSpelledAs, controllerTag, splitControllerTag } from '../../../core/io/controllerTag'
import type { PlcTagList, PlcTagProtocol } from '../../links/externalPlc'
import type { ProgramCheck, ProgramTag } from '../../program/tagVerdicts'
import { loadProgramTags, programTagChoices, rankTagNames, tagMisfit } from './tagSuggest'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.tagField', {
  placeholder: 'PLC tag…',
  more: { one: '{n} more, keep typing', other: '{n} more, keep typing' },
  inProgram: 'In the program',
  uses: { one: '{n} part', other: '{n} parts' },
  read: "Read the PLC's tags",
  readAgain: "Read the PLC's tags again",
  onPlc: 'On the PLC',
  onPlcCount: { one: 'On the PLC ({n} tag)', other: 'On the PLC ({n} tags)' },
  readOnRun: "The PLC's tags are read when the scene runs.",
  readWhenStopped: "Stop the scene to read the PLC's tags.",
  reading: 'Reading the tags of {endpoint}…',
  readFailed: "Could not read the PLC's tags: {error}",
  noAnswer: 'no answer',
  typeToSearch: 'Type to search them.',
  noTags: 'The PLC published no tags a part can be wired to.',
  noneFits: 'None fits what is typed.',
  truncated: 'The PLC has more tags than were read, so one not listed may still be there.',
  misfitInput: 'program reads it',
  misfitInputWhy: 'The program reads this, so nothing drives it for this part to read. Declare it as an output, or pick another.',
  misfitWritten: 'another part writes it',
  misfitWrittenWhy: 'Another part writes this, so the program reads it and nothing drives it for this part to read.',
  misfitOutput: 'program drives it',
  misfitOutputWhy: 'The program drives this, so it does not read what this part writes. Declare it as an input, or pick another.',
  noProgram: 'No program yet. Type a name, then declare it in the program.',
  noneOfType: 'The program declares no {type} variables yet. Type a name, then declare it in the program.',
  noneOfAny: 'The program declares no variables a part can be wired to yet. Type a name, then declare it in the program.',
  newName: 'Nothing in the program fits. A new name connects once the program declares it.',
  controller: 'Controller',
  controllerTitle: 'Which PLC this tag is on: the program in this app (or the external PLC that runs instead of it), or one of the other controllers set up in Controller Properties.',
  main: 'Program',
  mainExternal: 'External PLC',
})

/** Where a tag field's suggestions come from beyond the scene: the Inspector provides it. */
export interface TagSources {
  /** the program with what it is compiled under: what a field suggests and says about its tag (program/tagVerdicts.ts) */
  check: ProgramCheck
  /** the PLC's tag list, when the link is OPC UA, ADS or EtherNet/IP and the list is of the PLC the settings name; else null */
  plc: Readonly<PlcTagList> | null
  /** the PLC's tags can be read from here (desktop app, a link that lists them, no run holding the link) */
  canReadPlc: boolean
  readPlc: () => void
  /** the link is one whose PLC lists its tags, so a PLC section belongs in the list (it may still be empty) */
  plcLinked: boolean
  /** which link: an OPC UA run browses the PLC itself, while the others are read only while stopped. Absent: OPC UA */
  plcProtocol?: PlcTagProtocol
  /** an external PLC link is on (any protocol): parts may be wired to its tags, so an empty program is not a gap */
  external: boolean
  /** the named controllers a tag may be put on: the ones the project lists and the ones the scene's tags name */
  controllers: readonly string[]
  /** the default controller's name: a tag typed with it in front is written without it, as its tags are */
  defaultName?: string
  /**
   * the controller the part's Controller row names for every tag (inspector/controllerRow.tsx; null: the default one).
   * The field then shows no picker of its own, and a tag typed into it empty goes there. Absent with no row, or while
   * the part's tags disagree.
   */
  partController?: string | null
}

export const TagSourcesContext = createContext<TagSources | null>(null)

/** The part's Controller row (controllerRow.tsx), and the tag field it is drawn above, by param key. */
export const ControllerRowContext = createContext<{ above: string; row: ReactNode } | null>(null)

/** How many of each source the list shows before saying how many more fit. */
const PROGRAM_LIMIT = 8
const PLC_LIMIT = 50

/** The list's tallest (its CSS max-height, `.tag-suggest`), and the gap it keeps from the window's edges. */
const LIST_MAX_HEIGHT = 300
const EDGE = 8

type Row =
  | {
      kind: 'name'
      name: string
      detail?: string
      uses?: number
      /** picking it would leave this field unconnected: a short note shown in the row, and the full reason */
      misfit?: { note: string; why: string }
    }
  | { kind: 'action'; label: string; run: () => void }
interface Section {
  id: 'program' | 'plc'
  title: string
  rows: Row[]
  /** a line under the rows: how many more fit, or why there are none */
  notes: string[]
}

export function TagField({
  label,
  value,
  mixed,
  tooltip,
  disabled,
  labelExtra,
  extra,
  sceneUses,
  written,
  stType,
  dir,
  onCommit,
}: {
  label: string
  value: string
  mixed: boolean
  tooltip?: string
  disabled: boolean
  labelExtra?: ReactNode
  extra?: ReactNode
  /** the tags the scene's parts hold, already filtered (not another type), with how many tag fields hold each */
  sceneUses: ReadonlyMap<string, number>
  /** the scene's tags some part writes, which a field the part reads cannot be driven through */
  written: ReadonlySet<string>
  /** the field's declared ST type, which the program's and the scene's suggestions match */
  stType?: string
  /** which way the part uses the tag: the program variables that connect that way are listed first */
  dir?: 'in' | 'out'
  onCommit: (v: string) => void
}) {
  const sources = useContext(TagSourcesContext)
  // the controller the tag names, picked in front of the box, and the tag on it, which the box holds
  const stored = splitControllerTag(value)
  // the part's Controller row: when it names one controller, an empty field's tag goes there
  const partController = sources?.partController
  const startOn = (c: string | null, local: string): string | null => (local.trim() === '' ? (partController ?? null) : c)
  const [controller, setController] = useState<string | null>(startOn(stored.controller, stored.local))
  const controllerRef = useRef(controller)
  const named = sources?.controllers ?? []
  const choices = stored.controller !== null && !named.includes(stored.controller) ? [...named, stored.controller] : named
  const picker = choices.length > 0 && partController === undefined
  const [text, setText] = useState(stored.local)
  const textRef = useRef(text)
  const show = (t: string): void => {
    textRef.current = t
    setText(t)
  }
  const focused = useRef(false)
  // a field nobody typed in is never committed (see TextField); and until something is typed, the list is not filtered
  const edited = useRef(false)
  const [typed, setTyped] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // null until first read, so the list does not say the program has nothing while it loads
  const [programTags, setProgramTags] = useState<readonly ProgramTag[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)

  useEffect(() => {
    if (focused.current) return
    const { controller: c, local } = splitControllerTag(value)
    show(mixed ? '' : local)
    controllerRef.current = mixed ? null : startOn(c, local)
    setController(controllerRef.current)
  }, [value, mixed, partController])
  /** the tag a typed text stands for: on the picked controller, unless the text names one itself, which is then written
   *  as the controller is known (IEC names ignore case), so `cell2::` joins Cell2's tags */
  const full = (typed: string): string => {
    const { controller: c, local } = splitControllerTag(typed)
    if (c === null) return controllerTag(controllerRef.current, typed)
    return sources?.defaultName?.toLowerCase() === c.toLowerCase() ? local : controllerSpelledAs(typed, named)
  }

  // the program's tags, read when the list first opens (and again if the program changes while it is open)
  const check = sources?.check
  useEffect(() => {
    if (!open || !check) return
    let live = true
    void loadProgramTags(check)
      .then((tags) => {
        if (live) setProgramTags(tags)
      })
      .catch((e: unknown) => console.warn('[oip] reading the program tags failed', e))
    return () => {
      live = false
    }
  }, [open, check])

  // the list hangs off the box in the viewport, so the Inspector's scrolling cannot clip it; it follows a scroll.
  // Being fixed, it cannot be scrolled to either: a box low in the window opens it upward when there is more room
  // there, its height capped to the room it has, and it is kept inside the window's sides.
  useLayoutEffect(() => {
    if (!open) return
    const win = input.current?.ownerDocument.defaultView ?? window
    const place = (): void => {
      const r = input.current?.getBoundingClientRect()
      if (!r) return
      const width = Math.max(r.width, 240)
      const left = Math.max(EDGE, Math.min(r.left, win.innerWidth - width - EDGE))
      const below = win.innerHeight - r.bottom - 2 - EDGE
      const above = r.top - 2 - EDGE
      setAt(
        below >= LIST_MAX_HEIGHT || below >= above
          ? { left, width, top: r.bottom + 2, maxHeight: Math.min(LIST_MAX_HEIGHT, below) }
          : { left, width, bottom: win.innerHeight - r.top + 2, maxHeight: Math.min(LIST_MAX_HEIGHT, above) },
      )
    }
    place()
    win.addEventListener('scroll', place, true)
    win.addEventListener('resize', place)
    return () => {
      win.removeEventListener('scroll', place, true)
      win.removeEventListener('resize', place)
    }
  }, [open])

  const commit = (t: string): void => {
    if (edited.current && (mixed || full(t) !== value)) onCommit(full(t))
    edited.current = false
  }
  const pick = (name: string): void => {
    show(name)
    edited.current = true
    commit(name)
    setOpen(false)
    input.current?.blur()
  }

  const query = typed ? text : ''
  // the program and the PLC browse are the default controller's: a named controller's tag has no suggestions here
  const sections = open && controller === null ? buildSections(query, sceneUses, programTags, stType, sources, dir, written) : []
  const rows = sections.flatMap((s) => s.rows)
  const activate = (row: Row): void => {
    if (row.kind === 'name') pick(row.name)
    else row.run()
  }

  return (
    <label className="field">
      <span className="field-label" title={tooltip}>
        {label}
        {labelExtra}
      </span>
      <span className="field-control">
        {picker && (
          <select
            className="tag-controller"
            aria-label={t(M.controller)}
            title={t(M.controllerTitle)}
            value={mixed ? MIXED : (controller ?? '')}
            disabled={disabled || mixed}
            data-testid="tag-controller"
            onChange={(e) => {
              const next = e.target.value === '' ? null : e.target.value
              controllerRef.current = next
              setController(next)
              // an empty tag stays empty: the pick applies to what is typed next
              if (textRef.current.trim() !== '') onCommit(controllerTag(next, textRef.current.trim()))
            }}
          >
            {mixed && (
              <option value={MIXED} disabled>
                --
              </option>
            )}
            {/* a tag with no name: the program here, or the external PLC that runs instead of it */}
            <option value="">{t(sources?.external ? M.mainExternal : M.main)}</option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {/* i18n-ok: the controller's name, as the tags spell it */}
                {c}
              </option>
            ))}
          </select>
        )}
        <input
          ref={input}
          type="text"
          value={text}
          placeholder={mixed ? '--' : t(M.placeholder)}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          data-testid="tag-field"
          onFocus={() => {
            focused.current = true
            edited.current = false
            setTyped(false)
            setActive(-1)
            setOpen(true)
          }}
          // Escape with nothing typed closes the list and keeps the box focused, so focus alone would not reopen it
          onClick={() => {
            if (!open) setOpen(true)
          }}
          onBlur={() => {
            focused.current = false
            setOpen(false)
            commit(textRef.current)
          }}
          onChange={(e) => {
            show(e.target.value)
            edited.current = true
            setTyped(true)
            setActive(-1)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) return setOpen(true)
              const n = rows.length
              if (n === 0) return
              setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1))
            } else if (e.key === 'Enter') {
              const row = open && active >= 0 ? rows[active] : undefined
              if (row) {
                e.preventDefault()
                activate(row)
              } else (e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              // one Escape cancels an edit, as in any field, closing the suggestions with it: they open on every
              // keystroke, so a press that only closed them would leave the edit for the next click elsewhere to
              // commit. With nothing typed (the list only browsed) there is no edit, and it just closes the list.
              if (open) {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                if (!edited.current) return
              }
              edited.current = false
              show(mixed ? '' : stored.local)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        {extra}
      </span>
      {open && at && sections.length > 0 && (
        <div
          className="tag-suggest"
          role="listbox"
          data-testid="tag-suggest"
          style={{ left: at.left, top: at.top, bottom: at.bottom, minWidth: at.width, maxHeight: at.maxHeight }}
          // keep the box focused: a press on the list must not blur it before the click picks
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.preventDefault()}
        >
          {sections.map((s) => (
            <div key={s.id} className="tag-suggest-section" data-testid={`tag-suggest-${s.id}`}>
              <div className="tag-suggest-title">{s.title}</div>
              {s.rows.map((row) => {
                const i = rows.indexOf(row)
                return (
                  <div
                    key={row.kind === 'name' ? `n:${row.name}` : `a:${row.label}`}
                    role="option"
                    aria-selected={i === active}
                    className={`tag-suggest-row${row.kind === 'action' ? ' tag-suggest-action' : ''}${row.kind === 'name' && row.misfit ? ' misfit' : ''}${i === active ? ' active' : ''}`}
                    title={row.kind === 'name' ? row.misfit?.why : undefined}
                    data-testid={row.kind === 'name' ? 'tag-suggest-item' : 'tag-suggest-action'}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => activate(row)}
                  >
                    <span className="tag-suggest-name">{row.kind === 'name' ? row.name : row.label}</span>
                    {row.kind === 'name' && (row.detail || row.uses || row.misfit) && (
                      <span className="tag-suggest-meta">
                        {row.misfit && <span className="tag-suggest-misfit">{row.misfit.note}</span>}
                        {row.uses ? <span className="tag-suggest-detail">{t(M.uses, { count: row.uses, n: row.uses.toLocaleString() })}</span> : null}
                        {row.detail && <span className="tag-suggest-detail">{row.detail}</span>}
                      </span>
                    )}
                  </div>
                )
              })}
              {s.notes.map((n) => (
                <div key={n} className="tag-suggest-note">
                  {n}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </label>
  )
}

/** a mixed picker's value: `::` is in no controller name, so no option can share it */
const MIXED = '::'

/** "{n} more, keep typing": `count` picks the plural form, `n` is the count as shown. */
const moreNote = (n: number): string => t(M.more, { count: n, n: n.toLocaleString() })

const MISFIT = {
  input: { note: M.misfitInput, why: M.misfitInputWhy },
  written: { note: M.misfitWritten, why: M.misfitWrittenWhy },
  output: { note: M.misfitOutput, why: M.misfitOutputWhy },
} as const

/**
 * The list's sections for what is typed: the program's variables of the field's type, each with how many of the
 * scene's tag fields hold it, then the PLC's. A name the program does not declare is not offered, even when parts
 * hold it: a part's tag connects only to the program (sim/behaviorBus.ts), so such a name connects to nothing, and
 * offering it would spread a typo. The field's mark says so instead. A variable declared the other way round for
 * the field (`dir`, `tagMisfit`) is offered after the ones that connect, saying why it would not: the user may be
 * looking for it, and the reason tells them what to change in the program. `program` is every tag the program has,
 * of any type, or null while it loads. With nothing to offer, the section says why and what to do. Exported for its
 * spec.
 */
export function buildSections(
  query: string,
  sceneUses: ReadonlyMap<string, number>,
  program: readonly ProgramTag[] | null,
  stType: string | undefined,
  sources: TagSources | null,
  dir?: 'in' | 'out',
  written: ReadonlySet<string> = new Set(),
): Section[] {
  const out: Section[] = []
  const taken = new Set<string>()
  const uses = new Map([...sceneUses].map(([name, n]) => [name.toLowerCase(), n]))
  const choices = programTagChoices(program ?? [], stType)
  const byName = new Map(choices.map((c) => [c.name, c]))
  // ranked by what is typed, then the ones that connect first, each half in the ranking's order
  const ranked = rankTagNames(query, choices.map((c) => c.name), Infinity).shown
  const misfitOf = new Map(ranked.map((name) => [name, tagMisfit(byName.get(name)!, dir, written)]))
  const ordered = [...ranked.filter((n) => !misfitOf.get(n)), ...ranked.filter((n) => misfitOf.get(n))]
  const shown = ordered.slice(0, PROGRAM_LIMIT)
  if (shown.length > 0) {
    for (const n of shown) taken.add(n.toLowerCase())
    const rows: Row[] = shown.map((name) => {
      const misfit = misfitOf.get(name)
      return {
        kind: 'name',
        name,
        detail: byName.get(name)!.type,
        uses: uses.get(name.toLowerCase()) ?? 0,
        ...(misfit
          ? {
              misfit: {
                note: t(MISFIT[misfit].note),
                why: t(MISFIT[misfit].why),
              },
            }
          : {}),
      }
    })
    const more = ordered.length - shown.length
    out.push({
      id: 'program',
      title: t(M.inProgram),
      rows,
      notes: more > 0 ? [moreNote(more)] : [],
    })
  } else if (program !== null && sources && !sources.external) {
    // nothing to pick: say why, so an empty list does not read as a broken one. Not with an external PLC, whose tags
    // are the ones wired to
    const none =
      sources.check.source.trim() === ''
        ? t(M.noProgram)
        : query.trim() !== ''
          ? t(M.newName)
          : stType
            ? t(M.noneOfType, { type: stType })
            : t(M.noneOfAny)
    out.push({ id: 'program', title: t(M.inProgram), rows: [], notes: [none] })
  }
  if (sources?.plcLinked) out.push(plcSection(query, sources, taken))
  return out
}

function plcSection(query: string, sources: TagSources, taken: ReadonlySet<string>): Section {
  const plc = sources.plc
  const read: Row | null = sources.canReadPlc ? { kind: 'action', label: t(plc ? M.readAgain : M.read), run: sources.readPlc } : null
  if (!plc) {
    return { id: 'plc', title: t(M.onPlc), rows: read ? [read] : [], notes: read ? [] : [t(sources.plcProtocol && sources.plcProtocol !== 'opcua' ? M.readWhenStopped : M.readOnRun)] }
  }
  if (plc.state === 'reading') return { id: 'plc', title: t(M.onPlc), rows: [], notes: [t(M.reading, { endpoint: plc.endpoint })] }
  if (plc.state === 'failed') return { id: 'plc', title: t(M.onPlc), rows: read ? [read] : [], notes: [t(M.readFailed, { error: plc.error ?? t(M.noAnswer) })] }
  const title = t(M.onPlcCount, { count: plc.names.length, n: plc.names.length.toLocaleString() })
  const notes: string[] = []
  let rows: Row[] = []
  if (query.trim() === '') notes.push(t(plc.names.length > 0 ? M.typeToSearch : M.noTags))
  else {
    const found = rankTagNames(query, plc.names.filter((n) => !taken.has(n.toLowerCase())), PLC_LIMIT)
    rows = found.shown.map((name) => ({ kind: 'name', name }))
    if (found.more > 0) notes.push(moreNote(found.more))
    else if (rows.length === 0) notes.push(t(M.noneFits))
  }
  if (plc.truncated) notes.push(t(M.truncated))
  if (read) rows.push(read)
  return { id: 'plc', title, rows, notes }
}
