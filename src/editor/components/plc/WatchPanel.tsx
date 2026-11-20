import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { TagValue } from '../../../plc'
import { deviceTags } from '../../../plc/bindings'
import { listTags } from '../../../plc/tags'
import type { ScanTime } from '../../../sim/plcHost'
import { commandChord, commandDisabledReason, commandEnabled, getCommand, runCommand } from '../../commands'
import type { EditorController } from '../../controller'
import type { EditorState, EditorStore } from '../../store/store'
import { declaredTypeSets, formatPlcValue, typeOfKey, type DeclaredTypes } from '../../program/plcValueText'
import { devicesWiredTo, usePlcForces } from '../../program/plcForces'
import { addWatchNames, onWatchListChange, parseWatchNames, readWatchList, resolveWatch, saveWatchList, tabWatchListKey, type WatchRow } from '../../program/plcWatchList'
import { TrashIcon } from '../toolbarIcons'
import { ContextMenu, type MenuItem } from '../inspector/menu'
import { canEditDisplay, displayedValues, displayListFull, setDisplayed } from '../../program/displayValues'
import { MAX_DISPLAY_VALUES } from '../../../core/scene/sceneDisplay'
import { defineMessages, t } from '../../../core/i18n'
import { watchKeysOf } from '../../../core/watchTable'

const M = defineMessages('plcWatch', {
  scanProgram: 'Scan: last {last}, average {avg}, max {max}, every {interval}',
  scanTask: 'Task {task}: last {last}, average {avg}, max {max}, every {interval}',
  scanProgramContinuous: 'Scan: last {last}, average {avg}, max {max}, every physics step',
  scanTaskContinuous: 'Task {task}: last {last}, average {avg}, max {max}, every physics step',
  scanTitle:
    'How long the scans took to execute on this computer. The interval is simulated time, so a long scan slows the whole simulation instead of making the task late.',
  scanCount: { one: '{count} scan timed', other: '{count} scans timed' },
  step: 'Step',
  stepTitle: 'Advance the paused simulation by one physics step, with the scans due in it',
  stepTitleKey: 'Advance the paused simulation by one physics step, with the scans due in it ({chord})',
  withChord: '{text} ({chord})',
  reset: 'Reset',
  resetTitle: 'Start the average and the maximum over',
  stopped: 'Press Play to see live values and scan times',
  colName: 'Name',
  colValue: 'Value',
  colType: 'Type',
  colWired: 'Wired to',
  notInProgram: 'not in the running program',
  members: { one: '{count} value', other: '{count} values' },
  moreMembers: { one: '{count} more not listed', other: '{count} more not listed' },
  expand: 'Show the values under {name}',
  collapse: 'Hide the values under {name}',
  toggleTitle: 'Click to write the opposite value. A bit the program writes is written back by its next scan',
  editTitle: 'Click to write a new value. A variable the program writes is written back by its next scan',
  toggleForcedTitle: 'Forced: click to hold the opposite value',
  editForcedTitle: 'Forced: click to hold a new value',
  forced: 'forced',
  forcedTitle: 'Held at this value whatever the program writes or the scene feeds, until released',
  force: 'Force',
  forceTitle: 'Hold {name} at its value until released. The program reads it and the parts see it, whatever the program writes',
  forceBoolTitle: 'Hold {name} at its value until released, then click the value to hold the opposite. The program reads it and the parts see it, whatever the program writes',
  forceStoppedTitle: 'Press Play to force a value: a force holds a variable of the program until released, through Stop and the next Play',
  release: 'Release',
  releaseTitle: 'Give {name} back to the program from its next scan',
  setLabel: 'New value for {name}',
  reads: '{part}: its {field} reads this',
  writes: '{part}: its {field} writes this',
  uses: '{part}: its {field}',
  selectPart: 'Click to select it in the scene',
  moreParts: { one: '+{count} more', other: '+{count} more' },
  remove: 'Stop watching {name}',
  empty: 'Right-click a variable in the PLC panel and choose Add to Watch, or type its name below',
  emptyExternal: 'Add the tags wired to parts to see what the PLC sends and receives, or type a name below',
  addWired: { one: 'Add the {count} wired tag', other: 'Add all {count} wired tags' },
  noValue: 'no value from the PLC',
  display: 'Show on displays',
  displayOff: 'Stop showing on displays',
  displayHint: "Put this value beside the scene on the project's displays. Your Watch list stays your own",
  displayHintOff: "Take this value off the project's displays",
  displayFull: 'A display lists at most {count} values. Take one off to add another.',
  addLabel: 'Variables to watch',
  addPlaceholder: 'Name, or several separated by commas',
  add: 'Add',
  clear: 'Clear',
  clearTitle: 'Remove every variable from the watch list',
})

/** How often the panel re-reads the image while the program runs. The image itself arrives ten times a second
 *  (sim/plcHost.ts WATCH_HZ), so reading faster shows nothing new. */
const POLL_MS = 125
/** How long a value that just changed stays marked. */
const FLASH_MS = 700
/** Most names the add box suggests: the whole image of a large program is thousands of values. */
const MAX_SUGGESTIONS = 2000
/** Parts listed in a row's Wired to before the rest are counted. */
const MAX_PARTS = 3
/** How long the declared types wait after an edit before they are read again: they take a parse. */
const TYPES_DELAY_MS = 250

/**
 * The Step button's tooltip: what it does, or while it is greyed why (commands.ts disabledReason), with the chord
 * this surface binds (F7 in the desktop app, Shift+. in the browser) so the tooltip also teaches the key.
 */
function stepTitle(): string {
  const cmd = getCommand('sim.step')
  const chord = cmd ? commandChord(cmd) : ''
  const reason = commandDisabledReason('sim.step')
  if (reason) return chord ? t(M.withChord, { text: reason, chord }) : reason
  return chord ? t(M.stepTitleKey, { chord }) : t(M.stepTitle)
}

/** A scan time in the unit that keeps it readable: microseconds below a millisecond. */
function duration(ms: number): string {
  // i18n-ok: units
  if (ms === 0) return '0 µs' // under the clock's grain (ScanTime says why)
  // i18n-ok: units
  if (ms < 1) return `${(ms * 1000).toFixed(ms < 0.01 ? 1 : 0)} µs`
  // i18n-ok: units
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
}
/** A task interval as the scan-time field writes it. */
function interval(sec: number): string {
  const ms = sec * 1000
  // i18n-ok: units
  return Number.isInteger(ms) ? `${ms} ms` : `${Number(ms.toFixed(3))} ms`
}

function scanLine(s: ScanTime): string {
  const p = { task: s.task, last: duration(s.lastMs), avg: duration(s.avgMs), max: duration(s.maxMs), interval: interval(s.periodSec) }
  if (s.kind === 'continuous') return t(s.task === '' ? M.scanProgramContinuous : M.scanTaskContinuous, p)
  return t(s.task === '' ? M.scanProgram : M.scanTask, p)
}

interface ValueCellProps {
  name: string
  rowKey: string | null
  value: TagValue | undefined
  type: string | undefined
  live: boolean
  flash: boolean
  /** held by a force (EditorController.forcePlcValue): a write changes the held value */
  forced: boolean
  controller: EditorController | null
  onError: (why: string | null) => void
}

/**
 * The value, and the way to write it: a BOOL toggles on a click, a number opens a field on one (Enter writes, Escape or
 * leaving it writes nothing, since a value written into a running machine should be meant). Text is set in the
 * declaration, so a STRING only shows.
 */
function ValueCell({ name, rowKey, value, type, live, flash, forced, controller, onError }: ValueCellProps): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const cls = `plc-watch-value${flash ? ' plc-watch-flash' : ''}${forced ? ' plc-watch-forced' : ''}`
  const badge = forced ? (
    <span className="plc-watch-forced-badge" data-testid="plc-watch-forced" title={t(M.forcedTitle)}>
      {t(M.forced)}
    </span>
  ) : null
  if (value === undefined) return <td className={cls} data-testid="plc-watch-value" />
  const text = formatPlcValue(value, type, 80)
  const writable = live && rowKey !== null && controller !== null && typeof value !== 'string'
  if (!writable) return <td className={cls} data-testid="plc-watch-value">{text}</td>
  if (typeof value === 'boolean')
    return (
      <td className={cls} data-testid="plc-watch-value">
        <button type="button" className={`plc-watch-cell plc-watch-bool${value ? ' on' : ''}`} data-testid="plc-watch-write" title={t(forced ? M.toggleForcedTitle : M.toggleTitle)} onClick={() => onError(controller.togglePlcBit(rowKey) ? null : t(M.notInProgram))}>
          {text}
        </button>
        {badge}
      </td>
    )
  if (draft !== null)
    return (
      <td className={cls} data-testid="plc-watch-value">
        <input
          className="ld-vars-field plc-watch-set"
          data-testid="plc-watch-set"
          aria-label={t(M.setLabel, { name })}
          spellCheck={false}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const why = controller.writePlcValue(rowKey, draft)
              onError(why)
              if (why === null) setDraft(null)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
              onError(null)
            }
          }}
        />
      </td>
    )
  return (
    <td className={cls} data-testid="plc-watch-value">
      {/* (the raw number to edit: a duration is milliseconds underneath, which is what a write takes) */}
      <button type="button" className="plc-watch-cell" data-testid="plc-watch-write" title={t(forced ? M.editForcedTitle : M.editTitle)} onClick={() => {
          onError(null)
          setDraft(String(value))
        }}>
        {text}
      </button>
      {badge}
    </td>
  )
}

interface WatchPanelProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
}

/**
 * The Watch dock: the variables the reader picked, with their live values, their types and the parts wired to them,
 * and how long the program's scans take. A dock of its own, so it can stay in view beside the running line while the
 * PLC panel is closed. Variables reach it by Add to Watch in the PLC panel (the code's and the rungs' right-click
 * menus) or by name here; the list is remembered per project in this browser (plcWatchList.ts). It watches any
 * controller: the program here, a PLC outside the app through its link (read only: it runs real equipment), or the
 * run this tab follows. A row's right-click Show on displays puts it on the project's displays (SceneJSON.display).
 */
export function WatchPanel({ store, state, controller }: WatchPanelProps): ReactElement {
  const project = tabWatchListKey(state.projectName, state.collab)
  const [names, setNames] = useState(() => readWatchList(project, state.projectName))
  const [shownFor, setShownFor] = useState(project)
  if (shownFor !== project) {
    setShownFor(project)
    setNames(readWatchList(project, state.projectName))
  }
  const setList = (next: string[]): void => {
    setNames(next)
    saveWatchList(project, next)
  }
  // an Add to Watch from the PLC panel, or this list changed in another copy of the panel
  useEffect(() => onWatchListChange((changed) => changed === project && setNames(readWatchList(project))), [project])

  // the controller owns the program's lifecycle; this mirrors whether one is attached
  const [attached, setAttached] = useState(() => controller?.programStatus.attached ?? false)
  useEffect(() => {
    if (!controller) return
    const sync = (): void => setAttached(controller.programStatus.attached)
    sync()
    return controller.onProgramStatus(sync)
  }, [controller])
  // values show while this tab runs, or follows someone's run (their values come with it: controller/liveView.ts); a
  // PLC outside the app has values too, through its link (controller/plcLinks.ts plcImage)
  const live = state.running || state.liveFollowing
  // written and forced only in a program running here: a PLC outside the app runs real equipment, and a view link or a
  // followed run is someone else's
  const writable = attached && state.running && !state.readOnly
  // a PLC outside the app is set up, so the empty list offers the tags the parts are wired to
  const external = state.externalPlc.enabled || state.externalPlc.controllers.some((c) => c.enabled && c.runsOn !== 'app')

  // the held forces: set and released here or from the toolbar's count; they stay through Stop
  const forces = usePlcForces(controller)

  const [image, setImage] = useState<Readonly<Record<string, TagValue>> | null>(null)
  const [times, setTimes] = useState<readonly ScanTime[]>([])
  // when each watched value last changed (performance.now), for the mark a change leaves; kept between polls
  const lastSeen = useRef(new Map<string, TagValue>())
  const changedAt = useRef(new Map<string, number>())
  const namesRef = useRef(names)
  namesRef.current = names
  const ctrlRef = useRef(controller)
  ctrlRef.current = controller
  useEffect(() => {
    if (!live) return
    const read = (): void => {
      const img = ctrlRef.current?.plcWatch ?? null
      if (img) {
        const now = performance.now()
        for (const n of namesRef.current) {
          const r = resolveWatch(n, img)
          const seen = r.key !== null ? [{ key: r.key, value: r.value! }] : r.members
          for (const { key, value } of seen) {
            const before = lastSeen.current.get(key)
            if (before !== undefined && before !== value) changedAt.current.set(key, now)
            lastSeen.current.set(key, value)
          }
        }
      }
      setImage(img)
      setTimes(ctrlRef.current?.plcScanTimes ?? [])
    }
    read()
    const id = setInterval(read, POLL_MS)
    return () => {
      clearInterval(id)
      setImage(null)
      setTimes([])
      lastSeen.current.clear()
      changedAt.current.clear()
    }
  }, [live])

  // the declared types, re-read a pause after the program text changes (they take a parse)
  const [types, setTypes] = useState<DeclaredTypes>(() => declaredTypeSets(state.stProgram))
  useEffect(() => {
    const id = window.setTimeout(() => setTypes(declaredTypeSets(state.stProgram)), TYPES_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [state.stProgram])
  // the parts that speak tags, re-derived when the scene's parts change (and only then)
  const parts = state.scene.parts
  const devices = useMemo(() => deviceTags(parts), [parts])
  // every tag a part is wired to, each once, and the type its field declares
  const wired = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const d of devices) for (const f of d.fields) if (f.value !== '' && !m.has(f.value)) m.set(f.value, f.type)
    return m
  }, [devices])
  // A row's right-click menu: Show on displays hands a value from this list, which is the reader's own, to the project's
  // displays (program/displayValues.ts). A menu item rather than a column, so the list does not read as the display's.
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const openRowMenu = (e: ReactMouseEvent, name: string): void => {
    e.preventDefault()
    const shown = displayedValues(state).includes(name)
    const full = !shown && displayListFull(state)
    setRowMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: t(shown ? M.displayOff : M.display),
          testid: 'plc-watch-display',
          title: full ? t(M.displayFull, { count: MAX_DISPLAY_VALUES }) : t(shown ? M.displayHintOff : M.displayHint),
          disabled: !canEditDisplay(state) || full,
          onClick: () => setDisplayed(store, name, !shown),
        },
      ],
    })
  }

  const [adding, setAdding] = useState('')
  const [suggestions, setSuggestions] = useState<readonly string[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const rows: WatchRow[] = names.map((n) => (image ? resolveWatch(n, image) : { name: n, key: null, value: undefined, members: [], more: 0 }))
  const now = performance.now()
  const flashing = (key: string | null): boolean => key !== null && now - (changedAt.current.get(key) ?? -Infinity) < FLASH_MS
  const add = (text: string): void => {
    const parsed = parseWatchNames(text)
    if (parsed.length === 0) return
    setList(addWatchNames(names, parsed))
    setAdding('')
  }
  const fillSuggestions = (): void => {
    const img = controller?.plcWatch
    const keys = img ? watchKeysOf(img) : listTagNames(state.stProgram)
    setSuggestions(keys.length > MAX_SUGGESTIONS ? keys.slice(0, MAX_SUGGESTIONS) : keys)
  }
  const toggleExpanded = (name: string): void => {
    const k = name.toUpperCase()
    setExpanded((cur) => {
      const next = new Set(cur)
      if (!next.delete(k)) next.add(k)
      return next
    })
  }
  // Force holds the value the row shows; Release gives it back to the program. Only for a value a write can change.
  const forceButton = (name: string, key: string | null, value: TagValue | undefined): ReactElement | null => {
    if (!writable || key === null || !controller || value === undefined || typeof value === 'string') return null
    const held = key in forces
    return (
      <button
        type="button"
        className={`plc-watch-btn plc-watch-force${held ? ' on' : ''}`}
        data-testid="plc-watch-force"
        aria-pressed={held}
        title={t(held ? M.releaseTitle : typeof value === 'boolean' ? M.forceBoolTitle : M.forceTitle, { name })}
        onClick={() => {
          if (held) controller.releasePlcForces(key)
          else setError(controller.forcePlcValue(key))
        }}
      >
        {t(held ? M.release : M.force)}
      </button>
    )
  }
  const wiredCell = (name: string, key: string | null): ReactElement => {
    const uses = devicesWiredTo(devices, name, key, controller?.plcAliases)
    return (
      <td className="plc-watch-wired" data-testid="plc-watch-wired">
        {uses.slice(0, MAX_PARTS).map((u) => {
          const what = { part: u.device.name, field: u.field }
          const how = u.section === 'VAR_INPUT' ? t(M.writes, what) : u.section === 'VAR_OUTPUT' ? t(M.reads, what) : t(M.uses, what)
          return (
            <button key={`${u.device.id}:${u.field}`} type="button" className="plc-watch-part" data-testid="plc-watch-part" data-part={u.device.id} title={`${how}. ${t(M.selectPart)}`} onClick={() => store.select(u.device.id)}>
              {u.device.name}
            </button>
          )
        })}
        {uses.length > MAX_PARTS && <span className="ld-vars-dim">{t(M.moreParts, { count: uses.length - MAX_PARTS })}</span>}
      </td>
    )
  }

  return (
    <div className="plc-watch" data-testid="plc-watch">
      <div className="plc-watch-scan" data-testid="plc-watch-scan" title={t(M.scanTitle)}>
        {!live ? (
          <span className="plc-watch-scan-lines ld-vars-dim">{t(M.stopped)}</span>
        ) : !(attached && state.running) ? null : (
          <>
            <div className="plc-watch-scan-lines">
              {times.map((s, i) => (
                <div key={`${s.task}:${i}`} data-testid="plc-watch-scan-line" data-scans={s.scans} data-avg-ms={s.avgMs} data-max-ms={s.maxMs}>
                  {scanLine(s)} <span className="ld-vars-dim">({t(M.scanCount, { count: s.scans })})</span>
                </div>
              ))}
            </div>
            {/* Here rather than in the toolbar: stepping is for watching values change, and these are the values.
                Greyed while running rather than hidden, so whoever has this dock open learns that it exists. */}
            <button type="button" className="plc-watch-btn" data-testid="plc-watch-step" disabled={!commandEnabled('sim.step')} title={stepTitle()} onClick={() => runCommand('sim.step')}>
              {t(M.step)}
            </button>
            <button type="button" className="plc-watch-btn" data-testid="plc-watch-reset" title={t(M.resetTitle)} onClick={() => controller?.resetPlcScanTimes()}>
              {t(M.reset)}
            </button>
          </>
        )}
        {names.length > 0 && (
          <button type="button" className="plc-watch-btn" data-testid="plc-watch-clear" title={t(M.clearTitle)} onClick={() => setList([])}>
            {t(M.clear)}
          </button>
        )}
      </div>
      <div className="plc-watch-scroll">
        <table className="ld-vars-table plc-watch-table">
          <thead>
            <tr>
              <th>{t(M.colName)}</th>
              <th>{t(M.colValue)}</th>
              <th>{t(M.colType)}</th>
              <th>{t(M.colWired)}</th>
              <th title={live ? undefined : t(M.forceStoppedTitle)} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded.has(r.name.toUpperCase())
              const structured = r.key === null && r.members.length > 0
              const type = typeOfKey(types, r.key ?? r.name) ?? wired.get(r.name) ?? undefined
              return (
                <Fragment key={r.name}>
                  <tr data-testid="plc-watch-row" data-name={r.name} onContextMenu={(e) => openRowMenu(e, r.name)}>
                    <td className="plc-watch-name">
                      {structured ? (
                        <button type="button" className="plc-watch-caret" aria-expanded={open} aria-label={t(open ? M.collapse : M.expand, { name: r.name })} onClick={() => toggleExpanded(r.name)}>
                          {open ? '▾' : '▸'}
                        </button>
                      ) : (
                        <span className="plc-watch-caret" />
                      )}
                      {r.name}
                    </td>
                    {structured ? (
                      <td className="plc-watch-value ld-vars-dim" data-testid="plc-watch-value">
                        {t(M.members, { count: r.members.length + r.more })}
                      </td>
                    ) : r.value === undefined && live && image ? (
                      <td className="plc-watch-value ld-vars-dim" data-testid="plc-watch-value">
                        {t(attached ? M.notInProgram : M.noValue)}
                      </td>
                    ) : (
                      <ValueCell name={r.name} rowKey={r.key} value={r.value} type={type} live={writable} flash={flashing(r.key)} forced={r.key !== null && r.key in forces} controller={controller} onError={setError} />
                    )}
                    <td className="plc-watch-type ld-vars-dim" data-testid="plc-watch-type">
                      {type ?? ''}
                    </td>
                    {wiredCell(r.name, r.key)}
                    <td className="plc-watch-actions">
                      {forceButton(r.name, r.key, r.value)}
                      <button type="button" className="ld-vars-btn" data-testid="plc-watch-remove" aria-label={t(M.remove, { name: r.name })} title={t(M.remove, { name: r.name })} onClick={() => setList(names.filter((n) => n !== r.name))}>
                        <TrashIcon size="1em" />
                      </button>
                    </td>
                  </tr>
                  {structured &&
                    open &&
                    r.members.map((m) => {
                      const mType = typeOfKey(types, m.key)
                      return (
                        <tr key={m.key} data-testid="plc-watch-member" data-name={m.key}>
                          <td className="plc-watch-name plc-watch-member">{m.key}</td>
                          <ValueCell name={m.key} rowKey={m.key} value={m.value} type={mType} live={writable} flash={flashing(m.key)} forced={m.key in forces} controller={controller} onError={setError} />
                          <td className="plc-watch-type ld-vars-dim">{mType ?? ''}</td>
                          {wiredCell(m.key, m.key)}
                          <td className="plc-watch-actions">{forceButton(m.key, m.key, m.value)}</td>
                        </tr>
                      )
                    })}
                  {structured && open && r.more > 0 && (
                    <tr>
                      <td colSpan={5} className="ld-vars-dim plc-watch-member">
                        {t(M.moreMembers, { count: r.more })}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="ld-vars-dim">
                  {t(external ? M.emptyExternal : M.empty)}
                  {external && wired.size > 0 && (
                    <button type="button" className="plc-watch-btn plc-watch-add-wired" data-testid="plc-watch-add-wired" onClick={() => setList(addWatchNames(names, [...wired.keys()]))}>
                      {t(M.addWired, { count: wired.size })}
                    </button>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="plc-watch-add">
        <input
          className="ld-vars-field"
          data-testid="plc-watch-add-name"
          aria-label={t(M.addLabel)}
          placeholder={t(M.addPlaceholder)}
          spellCheck={false}
          list="plc-watch-suggestions"
          value={adding}
          onFocus={fillSuggestions}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(adding)
            }
          }}
        />
        <datalist id="plc-watch-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" className="plc-watch-btn" data-testid="plc-watch-add" disabled={adding.trim() === ''} onClick={() => add(adding)}>
          {t(M.add)}
        </button>
      </div>
      {rowMenu && <ContextMenu x={rowMenu.x} y={rowMenu.y} items={rowMenu.items} onClose={() => setRowMenu(null)} />}
      {error && (
        <div className="ld-vars-error plc-watch-error" role="alert" data-testid="plc-watch-error">
          ⚠ {error}
        </div>
      )}
    </div>
  )
}

/** The program's declared names, which the add box suggests while nothing runs. */
function listTagNames(source: string): string[] {
  try {
    return [...new Set(listTags(source).map((r) => r.name))]
  } catch {
    return []
  }
}
