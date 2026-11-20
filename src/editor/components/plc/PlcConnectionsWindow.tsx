// PLC Connections: wire the scene's machines to one controller's variables by picking both. The machines and their tag
// fields are on the left, the controller's variables on the right (the simulator's own program, or a PLC's read over
// ADS, EtherNet/IP or OPC UA, grouped by program, list or folder), and every connection to that controller below, each
// with the way it flows and a button that takes it off. Picking a field, then a variable, writes the variable's name into
// the field, which is all a connection is (the Inspector's Comms group shows the same name). Controller Properties shows
// it in its own place, from the PLC connections… button beside the controller's name, so the window is always about that
// one controller.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { variableFits } from '../../../core/io/plcVariables'
import type { PlcVariable, PlcVariableGroup } from '../../../core/io/plcVariables'
import type { EditorController } from '../../controller'
import { dialogHost } from '../../dialogHost'
import { adsEndpoint, eipEndpoint } from '../../links/externalPlcStatus'
import type { PlcTagList } from '../../links/externalPlcStatus'
import { canList, readPlcVariables } from '../../links/plcVariables'
import { connectableControllers, connectionMachines, connectionsOf, programVariableGroups, withConnection } from '../../program/plcConnections'
import type { ConnectionField, ConnectionMachine, VariableSource } from '../../program/plcConnections'
import type { EditorState, EditorStore } from '../../store/store'
import { loadProgramTags } from '../inspector/tagSuggest'
import { trapTab, useModalKeys } from '../inspector/menu'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('plcConnections', {
  title: 'PLC Connections: {name}',
  whereAds: 'TwinCAT over ADS: {endpoint}',
  whereEip: 'EtherNet/IP: {endpoint}',
  whereOpcUa: 'OPC UA: {endpoint}',
  whereProgram: "The simulator's program",
  close: 'Close',
  done: 'Done',
  machines: 'Machines',
  plc: 'PLC variables',
  programVariables: 'Program variables',
  controllerScope: 'Controller',
  connections: 'Connections',
  reread: 'Read again',
  reading: 'Reading the variables…',
  failed: 'The variables could not be read: {why}',
  noVariables: 'The PLC has no variables a machine can use (a bit or a number).',
  noProgramVariables: 'The program declares no variable a machine can use (a bit or a number).',
  more: { one: '{n} more: type to filter them.', other: '{n} more: type to filter them.' },
  filter: 'Filter',
  noMachines: 'No machine in the scene has a tag field.',
  noConnections: 'No connections to this controller yet.',
  pickField: 'Pick a machine field, then a variable, to connect them.',
  pickVariable: 'Now pick a variable for {machine}: {field}.',
  wrongTypeBit: '{variable} is {type}, and {field} needs a bit (BOOL).',
  wrongTypeNumber: '{variable} is {type}, and {field} needs a number.',
  moveFromDefault: '{machine}: {field} is wired to the default controller. Pick {variable} again to move it here.',
  moveFrom: '{machine}: {field} is wired to {controller}. Pick {variable} again to move it here.',
  connected: 'Connected {machine}: {field} to {variable}.',
  alsoWritten: 'Connected {machine}: {field} to {variable}. {other} writes it too, so the PLC sees whichever wrote last.',
  programInput: 'Connected {machine}: {field} to {variable}. The program reads {variable} and never drives it, so the machine gets nothing from it.',
  programOutput: 'Connected {machine}: {field} to {variable}. The program drives {variable} itself, so what the machine writes is lost.',
  removed: 'Took {variable} off {machine}: {field}.',
  remove: 'Remove this connection',
  fromPlc: 'The machine reads it from the PLC',
  toPlc: 'The machine writes it to the PLC',
  unfitDir: "The program uses this variable the same way the field does, so they would not connect",
  legend: '< from the PLC   > to the PLC',
  elsewhereDefault: 'Wired to the default controller',
  elsewhere: 'Wired to {controller}',
  commsOff: 'comms off: Play connects none of its fields',
  noController: '{name} reads addresses, not names (Modbus, S7 or SLMP), so there are no variables to list. Its machines are wired in the Inspector.',
  oldShell: "This version of the desktop app cannot list a PLC's variables. Update it to use this window.",
  needsDesktop: "Reading a PLC's variables needs the desktop app: a browser tab cannot reach the PLC.",
  readOnly: 'This project is open read-only, so connections cannot be changed here.',
  undoConnect: 'Connect {field} to {variable}',
  undoRemove: 'Disconnect {field}',
})

/** How many of a group's variables are shown before the rest wait for a filter: a large PLC lists tens of thousands. */
const SHOWN_PER_GROUP = 200

/** `<` for what a machine reads from the PLC, `>` for what it writes to it: the arrow points the way the value goes. */
// i18n-ok: arrows
const arrow = (dir: ConnectionField['dir']): string => (dir === 'fromPlc' ? '<' : dir === 'toPlc' ? '>' : '·')

interface Picked {
  partId: string
  machine: string
  key: string
}

/**
 * Why a program variable would leave a field unconnected, as the tag field asks it (inspector/tagSuggest.ts tagMisfit):
 * a field the machine reads needs a variable the program drives, and one the machine writes needs one the program reads.
 */
function dirMisfit(v: PlcVariable, dir: ConnectionField['dir']): 'input' | 'output' | null {
  if (dir === 'fromPlc' && v.dir === 'in') return 'input'
  if (dir === 'toPlc' && v.dir === 'out') return 'output'
  return null
}

function whereText(source: VariableSource): string {
  if (source.kind === 'ads') return t(M.whereAds, { endpoint: adsEndpoint(source.netId, source.port) })
  if (source.kind === 'eip') return t(M.whereEip, { endpoint: eipEndpoint(source) })
  if (source.kind === 'opcua') return t(M.whereOpcUa, { endpoint: source.endpoint })
  return t(M.whereProgram)
}

export function PlcConnectionsWindow({
  store,
  state,
  controller,
  plcName,
  onClose,
}: {
  store: EditorStore
  state: EditorState
  controller: EditorController
  /** the controller it wires, null for the default one */
  plcName: string | null
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const plc = useMemo(() => connectableControllers(state.externalPlc).find((c) => (c.name ?? '').toLowerCase() === (plcName ?? '').toLowerCase()), [state.externalPlc, plcName])
  const shownName = plcName ?? state.externalPlc.mainName
  const source = plc?.source ?? null
  // the source's settings as one key, so the read starts again only when they change
  const sourceKey = source ? JSON.stringify(source) : ''
  const listable = source !== null && canList(controller, source)
  const [list, setList] = useState<PlcTagList | 'reading' | null>(null)
  const [reads, setReads] = useState(0)
  const program = state.stProgram
  const { stDialect: dialect, controller: table, stScanMs: scanMs } = state
  const check = useMemo(() => ({ source: program, dialect, controller: table, scanMs }), [program, dialect, table, scanMs])
  const [programGroups, setProgramGroups] = useState<PlcVariableGroup[] | null>(null)
  // the groups opened by hand; null until the first click, while only the first group is open
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null)
  // the groups closed by hand while a filter is typed (every group with a match is open otherwise); cleared with it
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const [picked, setPicked] = useState<Picked | null>(null)
  // a field wired to another controller moves here on a second pick of the same variable
  const [moving, setMoving] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [note, setNote] = useState<{ text: string; problem?: boolean } | null>(null)
  const locked = state.readOnly

  // read a PLC's variables when the window opens, when its settings change, and on Read again
  useEffect(() => {
    if (!source || source.kind === 'program' || !listable) return
    let live = true
    setList('reading')
    void readPlcVariables(controller, source).then(
      (r) => live && setList(r),
      (e: unknown) => live && setList({ protocol: source.kind, endpoint: '', from: [], state: 'failed', names: [], groups: [], variables: [], truncated: false, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
    // sourceKey stands for `source`, which is a new object on every settings change
  }, [controller, sourceKey, listable, reads])

  // the program's variables, kept up to date with the program as it is edited
  useEffect(() => {
    if (source?.kind !== 'program') return
    let live = true
    void loadProgramTags(check)
      .then((tags) => live && setProgramGroups(programVariableGroups(tags)))
      .catch((e: unknown) => console.warn('[oip] reading the program variables failed', e))
    return () => {
      live = false
    }
  }, [source?.kind, check])

  const machines = useMemo(() => connectionMachines(state.scene.parts, plc?.name ?? null), [state.scene.parts, plc?.name])
  const connections = useMemo(() => connectionsOf(machines), [machines])
  // the picked field as it is now: a pick whose part or field is gone (deleted, undone, a collaborator's edit) is no pick
  const pickedField = useMemo(() => {
    if (!picked) return null
    const m = machines.find((x) => x.id === picked.partId)
    const f = m?.fields.find((x) => x.key === picked.key)
    return m && f ? { machine: m, field: f } : null
  }, [picked, machines])

  const all: PlcVariableGroup[] | null = source?.kind === 'program' ? programGroups : list && list !== 'reading' && list.state === 'ready' ? list.groups : null
  const want = filter.trim().toLowerCase()
  const groups = useMemo(() => {
    if (!all) return []
    if (!want) return all
    return all.map((g) => ({ ...g, variables: g.variables.filter((v) => v.name.toLowerCase().includes(want)) })).filter((g) => g.variables.length > 0)
  }, [all, want])

  const commit = (partId: string, key: string, variable: string, label: string): boolean => {
    const next = withConnection(store.getState().scene, partId, key, plc?.name ?? null, variable)
    if (!next) return false
    store.commit(label, next)
    return true
  }

  const pickVariable = (v: PlcVariable): void => {
    if (!pickedField) return setNote({ text: t(M.pickField) })
    const { machine: m, field: f } = pickedField
    const names = { machine: m.name, field: f.label, variable: v.name }
    if (!variableFits(v, f.type)) {
      return setNote({ text: t(f.type === 'BOOL' ? M.wrongTypeBit : M.wrongTypeNumber, { variable: v.name, type: v.typeName, field: f.label }), problem: true })
    }
    if (f.elsewhere !== undefined && moving !== v.name) {
      setMoving(v.name)
      return setNote({ text: f.elsewhere === null ? t(M.moveFromDefault, names) : t(M.moveFrom, { ...names, controller: f.elsewhere }), problem: true })
    }
    // a second writer is a real flaw a scene may have: warned about, as the Inspector's tag field does, not refused
    const other = f.dir === 'toPlc' ? otherWriter(machines, m.id, f.key, v.name) : null
    if (!commit(m.id, f.key, v.name, t(M.undoConnect, { field: f.label, variable: v.name }))) return
    const misfit = dirMisfit(v, f.dir)
    setNote(
      other
        ? { text: t(M.alsoWritten, { ...names, other }), problem: true }
        : misfit
          ? { text: t(misfit === 'input' ? M.programInput : M.programOutput, names), problem: true }
          : { text: t(M.connected, names) },
    )
    setPicked(null)
    setMoving(null)
  }

  useModalKeys(onClose, (e) => {
    if (ref.current) trapTab(ref.current, e)
  })

  const isOpen = (name: string, i: number): boolean => (want !== '' ? !shut.has(name) : opened ? opened.has(name) : i === 0)
  const toggle = (name: string): void => {
    if (want !== '') {
      const next = new Set(shut)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return setShut(next)
    }
    const next = new Set(opened ?? (all ?? []).slice(0, 1).map((g) => g.name))
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpened(next)
  }

  const variablesPane = (): ReactElement => {
    const isProgram = source?.kind === 'program'
    const reading = !isProgram && list === 'reading'
    const failed = !isProgram && list && list !== 'reading' && list.state === 'failed' ? list.error : null
    return (
      <section className="plc-conn-pane" aria-label={t(isProgram ? M.programVariables : M.plc)} data-testid="plc-conn-variables">
        <div className="plc-conn-head">
          {t(isProgram ? M.programVariables : M.plc)}
          {!isProgram && (
            <button className="plc-conn-reread" onClick={() => setReads((n) => n + 1)} disabled={reading} data-testid="plc-conn-reread">
              {t(M.reread)}
            </button>
          )}
        </div>
        <input
          type="text"
          className="plc-conn-filter"
          placeholder={t(M.filter)}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setShut(new Set())
          }}
          data-testid="plc-conn-filter"
        />
        {reading && <div className="ctl-dim">{t(M.reading)}</div>}
        {failed !== null && <div className="ctl-problem">{t(M.failed, { why: failed ?? '' })}</div>}
        {all && all.length === 0 && <div className="ctl-dim">{t(isProgram ? M.noProgramVariables : M.noVariables)}</div>}
        {groups.map((g, i) => {
          const open = isOpen(g.name, i)
          const shown = open ? g.variables.slice(0, SHOWN_PER_GROUP) : []
          return (
            <div key={g.name}>
              <button className="plc-conn-group plc-conn-toggle" onClick={() => toggle(g.name)} aria-expanded={open} data-testid="plc-conn-group">
                {/* i18n-ok: an arrow and the PLC's own list name */}
                {open ? '▾' : '▸'} {g.name === '' ? t(M.controllerScope) : g.name} <span className="ctl-dim">{g.variables.length}</span>
              </button>
              {shown.map((v) => {
                const unfit = pickedField !== null && (!variableFits(v, pickedField.field.type) || dirMisfit(v, pickedField.field.dir) !== null)
                return (
                  <button
                    key={v.name}
                    className={`plc-conn-row${unfit ? ' is-unfit' : ''}`}
                    disabled={locked}
                    title={pickedField && dirMisfit(v, pickedField.field.dir) ? t(M.unfitDir) : undefined}
                    onClick={() => pickVariable(v)}
                    data-testid="plc-conn-variable"
                    data-name={v.name}
                  >
                    {/* i18n-ok: the PLC's own variable name and type */}
                    <span className="plc-conn-name">{v.short}</span>
                    <span className="plc-conn-type">{v.typeName}</span>
                  </button>
                )
              })}
              {open && g.variables.length > shown.length && (
                <div className="ctl-dim plc-conn-more" data-testid="plc-conn-more">
                  {t(M.more, { n: g.variables.length - shown.length })}
                </div>
              )}
            </div>
          )
        })}
      </section>
    )
  }

  const body = (): ReactElement => {
    if (!plc || !source) return <div className="ctl-banner" data-testid="plc-conn-no-controller">{t(M.noController, { name: shownName })}</div>
    if (!listable) return <div className="ctl-banner">{t(hostFor(controller, source) ? M.oldShell : M.needsDesktop)}</div>
    return (
      <>
        {locked && <div className="ctl-banner">{t(M.readOnly)}</div>}
        <div className="plc-conn-panes">
          <MachinesPane
            machines={machines}
            picked={pickedField ? picked : null}
            locked={locked}
            onPick={(m, f, sel) => {
              setPicked(sel ? null : { partId: m.id, machine: m.name, key: f.key })
              setMoving(null)
              setNote(sel ? null : { text: t(M.pickVariable, { machine: m.name, field: f.label }) })
            }}
          />
          {variablesPane()}
        </div>
        <div className={note?.problem ? 'ctl-problem plc-conn-note' : 'ctl-dim plc-conn-note'} role="status" data-testid="plc-conn-note">
          {(picked && !pickedField ? null : note?.text) ?? t(M.pickField)}
        </div>
        <section className="plc-conn-pane plc-conn-list" aria-label={t(M.connections)} data-testid="plc-conn-list">
          <div className="plc-conn-head">
            {t(M.connections)} <span className="ctl-dim">{t(M.legend)}</span>
          </div>
          {connections.length === 0 && <div className="ctl-dim">{t(M.noConnections)}</div>}
          {connections.map((c) => (
            <div key={`${c.partId}:${c.key}`} className="plc-conn-line" data-testid="plc-conn-line">
              {/* i18n-ok: names from the scene and the PLC */}
              <span>{`${c.machine}: ${c.field}`}</span>
              <span className="plc-conn-arrow" title={c.dir === 'fromPlc' ? t(M.fromPlc) : c.dir === 'toPlc' ? t(M.toPlc) : undefined}>
                {arrow(c.dir)}
              </span>
              <span className="plc-conn-var">{c.variable}</span>
              <button
                className="plc-conn-remove"
                title={t(M.remove)}
                aria-label={t(M.remove)}
                disabled={locked}
                onClick={() => commit(c.partId, c.key, '', t(M.undoRemove, { field: c.field })) && setNote({ text: t(M.removed, { variable: c.variable, machine: c.machine, field: c.field }) })}
                data-testid="plc-conn-remove"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </section>
      </>
    )
  }

  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="author-dialog plc-conn-dialog" role="dialog" aria-label={t(M.title, { name: shownName })} data-testid="plc-connections" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title, { name: shownName })}</h2>
          {source && <span className="ctl-dim plc-conn-where">{whereText(source)}</span>}
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="controller-dialog-body">{body()}</div>
        <div className="props-foot">
          <button className="props-ok" onClick={onClose} autoFocus data-testid="plc-conn-done">
            {t(M.done)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}

/** Whether the app has the protocol's host at all: without it a browser tab is the reason, with it an older shell. */
function hostFor(c: EditorController, source: VariableSource): boolean {
  if (source.kind === 'ads') return c.adsHost !== null
  if (source.kind === 'eip') return c.eipHost !== null
  if (source.kind === 'opcua') return c.opcUaHost !== null
  return true
}

/** Another enabled machine field that already writes `variable` to this controller, as "Machine: Field", or null. */
function otherWriter(machines: readonly ConnectionMachine[], partId: string, key: string, variable: string): string | null {
  const v = variable.toLowerCase()
  for (const m of machines) {
    if (!m.enabled) continue
    for (const f of m.fields) {
      if (f.dir === 'toPlc' && f.variable.toLowerCase() === v && !(m.id === partId && f.key === key)) return `${m.name}: ${f.label}`
    }
  }
  return null
}

function MachinesPane({
  machines,
  picked,
  locked,
  onPick,
}: {
  machines: readonly ConnectionMachine[]
  picked: Picked | null
  locked: boolean
  onPick: (m: ConnectionMachine, f: ConnectionField, selected: boolean) => void
}): ReactElement {
  return (
    <section className="plc-conn-pane" aria-label={t(M.machines)} data-testid="plc-conn-machines">
      <div className="plc-conn-head">{t(M.machines)}</div>
      {machines.length === 0 && <div className="ctl-dim">{t(M.noMachines)}</div>}
      {machines.map((m) => (
        <div key={m.id}>
          <div className="plc-conn-group">
            {/* i18n-ok: the part's own name */}
            {m.name} <span className="ctl-dim">{m.kind}</span>
            {!m.enabled && <span className="ctl-dim" data-testid="plc-conn-comms-off"> · {t(M.commsOff)}</span>}
          </div>
          {m.fields.map((f) => {
            const sel = picked?.partId === m.id && picked.key === f.key
            return (
              <button
                key={f.key}
                className={`plc-conn-row${sel ? ' is-picked' : ''}`}
                disabled={locked}
                title={f.dir === 'fromPlc' ? t(M.fromPlc) : f.dir === 'toPlc' ? t(M.toPlc) : undefined}
                onClick={() => onPick(m, f, sel)}
                data-testid="plc-conn-field"
                data-part={m.id}
                data-key={f.key}
              >
                <span className={`plc-conn-dot${f.variable && m.enabled ? ' is-on' : ''}`} aria-hidden="true" />
                <span className="plc-conn-name">{f.label}</span>
                <span className="plc-conn-type">
                  {arrow(f.dir)} {f.type ?? ''}
                </span>
                {f.elsewhere !== undefined && <span className="ctl-dim">{f.elsewhere === null ? t(M.elsewhereDefault) : t(M.elsewhere, { controller: f.elsewhere })}</span>}
              </button>
            )
          })}
        </div>
      ))}
    </section>
  )
}
