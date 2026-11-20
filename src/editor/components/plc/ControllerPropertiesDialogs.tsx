import { useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Controller } from '../../../core/controller'
import { moveProgram, programNameError, removeProgram, renameProgram, renameTask, scheduleProgram, setProgramTask, setProgramType, setTaskPlc, setTaskTiming, taskNameError, type TagRename } from '../../../plc'
import { taskTree } from '../../../plc/taskTree'
import { dialogHost } from '../../dialogHost'
import { trapTab, useModalKeys } from '../inspector/menu'
import { CloseIcon } from '../toolbarIcons'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('controllerProps', {
  topLevel: 'top-level code',
  programTopLevel: '{name} (top-level code)',
  pinned: 'It runs the statements outside every PROGRAM, and nothing else would: move them into a PROGRAM first',
  close: 'Close',
  ok: 'OK',
  cancel: 'Cancel',
  apply: 'Apply',
  intervalError: 'The interval is a whole number of milliseconds, 1 or more.',
  priorityError: 'The priority is a whole number, 0 (the highest) or more.',
  editTask: 'Edit task {name}',
  taskTitle: 'Task Properties: {name}',
  name: 'Name',
  interval: 'Interval',
  intervalUnit: 'ms of simulated time',
  priority: 'Priority',
  priorityNote: '0 is the highest; tasks due together run in this order',
  notRunning: 'Not running',
  unscheduledList: 'Programs no task runs',
  addToTask: 'Add to this task',
  runsOnTask: 'Runs on this task, in order',
  scheduledList: 'Programs this task runs',
  removeTitle: 'Stop running it. Its code stays',
  removeFromTask: 'Remove from task',
  earlier: 'Run it earlier',
  later: 'Run it later',
  editProgram: 'Edit program {name}',
  hintTopLevel: 'Its variables are the top-level variables and keep their own names.',
  hintInstance: 'Its variables are reached as {name}.Name, so renaming it rewires the parts that use them.',
  programTitle: 'Program Properties: {name}',
  runs: 'Runs',
  runsTitle: 'A PROGRAM from the code, or the code outside every PROGRAM',
  missing: '{name} (missing)',
  task: 'Task',
  plc: 'Controller',
  plcTitle: 'The controller that runs this task and the program instances on it. Another controller runs them on memory and I/O of its own: the parts reach it by its name, like Cell2::%IX0.0.',
  plcDefault: '{name} (default)',
  plcOnPlc: '{name} (a PLC outside the app: it does not run this here)',
  plcTopLevel: 'The code outside every PROGRAM runs on the default controller: give that instance another task first.',
  everyStepOn: 'Every step on {name}',
  taskTitleGrouped: 'The task that runs this instance, and so the controller that does: each controller runs its own tasks',
  everyStep: 'every step (no task)',
})

// Task Properties and Program Properties: the organizer's two dialogs over the scene's controller table, opened by
// double-clicking a task or a program in the tree. One page each (a task's interval and priority, then the programs it
// calls; a program's name, what it runs and its task). There is not enough on either to tab through.
//
// Each works on a draft of the table and commits it as one edit on OK (Apply commits and stays), so a rename, a retime
// and three programs moved are one undo step, and Cancel is exactly nothing. The edits themselves are the table's
// (controllerEdits.ts).
//
// Not here: a watchdog, inhibiting a task, monitoring its scan time. A simulated controller has no watchdog to trip and
// scan times are not measured, so those would be controls that do nothing.

type Commit = (next: Controller, renames: TagRename[], label: string) => void

/** Instance `index` runs the top-level statements, so it cannot stop running them (nothing else would run them);
 *  null otherwise. */
const pinnedWhy = (controller: Controller, index: number, topLevelStatements: boolean): string | null =>
  controller.programs[index]?.type === undefined && topLevelStatements ? t(M.pinned) : null

function Shell({ title, testid, children, error, dirty, readOnly, onOk, onApply, onClose }: {
  title: string
  testid: string
  children: ReactNode
  error: string | null
  dirty: boolean
  /** why nothing here can be changed; the fields are shown disabled and OK only closes */
  readOnly: string | null
  onOk: () => void
  onApply: () => void
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // opened where the user is: the popped-out PLC window, when that is where they double-clicked
  const [host] = useState(dialogHost)
  useModalKeys(onClose, (e) => {
    const t = e.target as HTMLElement | null
    if (e.key === 'Enter' && t?.tagName === 'INPUT') {
      e.preventDefault()
      onOk()
    } else if (ref.current) trapTab(ref.current, e)
  })
  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div ref={ref} className="author-dialog props-dialog" role="dialog" aria-label={title} data-testid={testid} onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{title}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {readOnly && <p className="author-intro">{readOnly}</p>}
        <div className="props-body">{children}</div>
        <div className="props-foot">
          <span className="props-error" role="alert" data-testid={`${testid}-error`}>
            {error ? `⚠ ${error}` : ''}
          </span>
          <button className="props-ok" data-testid={`${testid}-ok`} onClick={onOk}>
            {t(M.ok)}
          </button>
          {!readOnly && <button onClick={onClose}>{t(M.cancel)}</button>}
          {!readOnly && (
            <button data-testid={`${testid}-apply`} disabled={!dirty} onClick={onApply}>
              {t(M.apply)}
            </button>
          )}
        </div>
      </div>
    </div>,
    host,
  )
}

/** A program as the schedule lists name it: the instance, and what it runs when that is not a PROGRAM of its name. */
const programLabel = (p: { name: string; type?: string }): string =>
  p.type === undefined ? t(M.programTopLevel, { name: p.name }) : p.type !== p.name ? `${p.name} : ${p.type}` : p.name

export function TaskPropertiesDialog({ types, topLevelStatements, controller, plcs, index, readOnly, onCommit, onClose }: {
  /** the PROGRAM types the code declares */
  types: readonly string[]
  /** the code outside every PROGRAM has statements */
  topLevelStatements: boolean
  controller: Controller
  /** the scene's controllers, for the task's Controller (absent: no choice is shown) */
  plcs?: { defaultName: string; named: readonly { name: string; simulated: boolean }[] }
  index: number
  readOnly: string | null
  onCommit: Commit
  onClose: () => void
}): ReactElement | null {
  const original = controller.tasks[index]
  const [draft, setDraft] = useState(controller)
  const [name, setName] = useState(original?.name ?? '')
  const [intervalText, setIntervalText] = useState(String(original?.intervalMs ?? 10))
  const [priority, setPriority] = useState(String(original?.priority ?? 10))
  // the task's controller as the choices spell it ('' for the default), so a name in another case is not "missing"
  const originalPlc = choiceOf(plcs, original?.plc)
  const [plc, setPlc] = useState(originalPlc)
  const [picked, setPicked] = useState<{ side: 'off' | 'on'; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!original) return null

  // the draft keeps the task's original name until OK, so the schedule below can find its programs by it
  const taskName = draft.tasks[index]!.name
  const scheduled = draft.programs.map((p, i) => ({ p, i })).filter(({ p }) => (p.task ?? '').toUpperCase() === taskName.toUpperCase())
  // what nothing runs: PROGRAMs of the code with no instance, and top-level statements no instance runs
  const tree = taskTree(types, draft, topLevelStatements)
  const unscheduled = [...(tree.topLevelUnrun ? [null] : []), ...tree.unscheduled]

  /** The table this dialog would commit, or the reason it cannot. */
  const result = (): { next: Controller; error: null } | { next: null; error: string } => {
    const to = name.trim()
    const why = to === original.name ? null : taskNameError(draft, index, to)
    if (why) return { next: null, error: why }
    const ms = Number(intervalText)
    const pri = Number(priority)
    if (intervalText.trim() === '' || !Number.isFinite(ms) || ms < 1) return { next: null, error: t(M.intervalError) }
    if (priority.trim() === '' || !Number.isFinite(pri) || pri < 0) return { next: null, error: t(M.priorityError) }
    let next = setTaskTiming(draft, index, { intervalMs: ms, priority: pri })
    if (plc !== originalPlc) {
      // the code outside every PROGRAM is the default controller's own, so its instance cannot go with the task
      const topLevel = draft.programs.some((p) => p.type === undefined && p.task !== undefined && p.task.toUpperCase() === original.name.toUpperCase())
      if (plc !== '' && topLevel) return { next: null, error: t(M.plcTopLevel) }
      next = setTaskPlc(next, index, plc === '' ? null : plc)
    }
    if (to !== original.name) next = renameTask(next, index, to)
    return { next, error: null }
  }
  const dirty = name.trim() !== original.name || Number(intervalText) !== original.intervalMs || Number(priority) !== original.priority || draft !== controller || plc !== originalPlc
  const commit = (close: boolean): void => {
    if (readOnly) return onClose()
    const r = result()
    if (r.next === null) return setError(r.error)
    setError(null)
    if (dirty) onCommit(r.next, [], t(M.editTask, { name: original.name }))
    if (close) onClose()
  }

  const add = (type: string | null): void => {
    setDraft(scheduleProgram(draft, type, taskName))
    setPicked(null)
  }
  const remove = (): void => {
    if (picked?.side !== 'on') return
    setDraft(removeProgram(draft, Number(picked.key)))
    setPicked(null)
  }
  /** Up or down within this task's list: past the neighbour on the same task, however far that is in the table. */
  const move = (delta: -1 | 1): void => {
    if (picked?.side !== 'on') return
    const at = scheduled.findIndex(({ i }) => i === Number(picked.key))
    const other = scheduled[at + delta]
    if (at < 0 || !other) return
    const from = Number(picked.key)
    setDraft(moveProgram(draft, from, other.i - from))
    setPicked({ side: 'on', key: String(other.i) })
  }
  const off = !!readOnly
  const pinned = picked?.side === 'on' ? pinnedWhy(draft, Number(picked.key), topLevelStatements) : null

  return (
    <Shell title={t(M.taskTitle, { name: original.name })} testid="task-props" error={error} dirty={dirty} readOnly={readOnly} onOk={() => commit(true)} onApply={() => commit(false)} onClose={onClose}>
      <div className="props-grid">
        <label htmlFor="task-props-name">{t(M.name)}</label>
        <input id="task-props-name" data-testid="task-props-name" autoFocus spellCheck={false} disabled={off} value={name} onFocus={(e) => e.currentTarget.select()} onChange={(e) => { setError(null); setName(e.target.value) }} />
        <label htmlFor="task-props-interval">{t(M.interval)}</label>
        <span className="props-unit">
          <input id="task-props-interval" data-testid="task-props-interval" type="number" min={1} step={1} disabled={off} value={intervalText} onFocus={(e) => e.currentTarget.select()} onChange={(e) => { setError(null); setIntervalText(e.target.value) }} /> {t(M.intervalUnit)}
        </span>
        <label htmlFor="task-props-priority">{t(M.priority)}</label>
        <span className="props-unit">
          <input id="task-props-priority" data-testid="task-props-priority" type="number" min={0} step={1} disabled={off} value={priority} onFocus={(e) => e.currentTarget.select()} onChange={(e) => { setError(null); setPriority(e.target.value) }} /> {t(M.priorityNote)}
        </span>
        {plcs && (plcs.named.length > 0 || original.plc !== undefined) && (
          <>
            <label htmlFor="task-props-plc">{t(M.plc)}</label>
            <select id="task-props-plc" data-testid="task-props-plc" disabled={off} value={plc} title={t(M.plcTitle)} onChange={(e) => { setError(null); setPlc(e.target.value) }}>
              <option value="">{t(M.plcDefault, { name: plcs.defaultName })}</option>
              {plcs.named.map((c) => (
                <option key={c.name} value={c.name}>
                  {/* i18n-ok: the controller's name, as the tags spell it */}
                  {c.simulated ? c.name : t(M.plcOnPlc, { name: c.name })}
                </option>
              ))}
              {originalPlc !== '' && !plcs.named.some((c) => c.name === originalPlc) && <option value={originalPlc}>{t(M.missing, { name: originalPlc })}</option>}
            </select>
          </>
        )}
      </div>
      <div className="props-schedule">
        <div className="props-list-col">
          <span className="props-list-title">{t(M.notRunning)}</span>
          <div className="props-list" data-testid="task-props-unscheduled" role="listbox" aria-label={t(M.unscheduledList)}>
            {unscheduled.map((type) => {
              const key = type ?? ''
              const on = picked?.side === 'off' && picked.key === key
              return (
                <button key={key} role="option" aria-selected={on} className={on ? 'on' : ''} disabled={off} onClick={() => setPicked({ side: 'off', key })} onDoubleClick={() => add(type)}>
                  {type ?? t(M.topLevel)}
                </button>
              )
            })}
          </div>
          <button data-testid="task-props-add" disabled={off || picked?.side !== 'off'} onClick={() => picked && add(picked.key === '' ? null : picked.key)}>
            {t(M.addToTask)}
          </button>
        </div>
        <div className="props-list-col">
          <span className="props-list-title">{t(M.runsOnTask)}</span>
          <div className="props-list" data-testid="task-props-scheduled" role="listbox" aria-label={t(M.scheduledList)}>
            {scheduled.map(({ p, i }) => {
              const on = picked?.side === 'on' && picked.key === String(i)
              return (
                <button key={i} role="option" aria-selected={on} className={on ? 'on' : ''} disabled={off} onClick={() => setPicked({ side: 'on', key: String(i) })}>
                  {programLabel(p)}
                </button>
              )
            })}
          </div>
          <button data-testid="task-props-remove" disabled={off || picked?.side !== 'on' || pinned !== null} onClick={remove} title={pinned ?? t(M.removeTitle)}>
            {t(M.removeFromTask)}
          </button>
        </div>
        <div className="props-move">
          <button data-testid="task-props-up" title={t(M.earlier)} aria-label={t(M.earlier)} disabled={off || picked?.side !== 'on'} onClick={() => move(-1)}>
            ↑
          </button>
          <button data-testid="task-props-down" title={t(M.later)} aria-label={t(M.later)} disabled={off || picked?.side !== 'on'} onClick={() => move(1)}>
            ↓
          </button>
        </div>
      </div>
    </Shell>
  )
}

/** A task-list value meaning "every step" on the controller named after it: `\u0000` is in no task name. */
/** A table's controller name (a task's or an instance's) as the dialogs' choices spell it: '' for the default controller,
 *  a listed controller's own spelling, or the name as written for one the project does not list. Names ignore case. */
function choiceOf(plcs: { defaultName: string; named: readonly { name: string }[] } | undefined, plc: string | undefined): string {
  if (plc === undefined || !plcs) return plc ?? ''
  const low = plc.toLowerCase()
  if (low === plcs.defaultName.toLowerCase()) return ''
  return plcs.named.find((c) => c.name.toLowerCase() === low)?.name ?? plc
}

const EVERY_STEP = '\u0000'

export function ProgramPropertiesDialog({ topLevelStatements, source, controller, types, plcs, index, readOnly, onCommit, onClose }: {
  /** the code outside every PROGRAM has statements */
  topLevelStatements: boolean
  /** the program text, for the wiring a rename moves */
  source: string
  controller: Controller
  /** the PROGRAM types the code declares, which the instance can be set to run */
  types: readonly string[]
  /** the scene's controllers (core/scene/scenePlcs.ts): the default one's name, and each other one with whether the
   *  simulator runs it. Absent, the instance runs on the default controller and no choice is shown */
  plcs?: { defaultName: string; defaultSimulated?: boolean; named: readonly { name: string; simulated: boolean }[] }
  index: number
  readOnly: string | null
  onCommit: Commit
  onClose: () => void
}): ReactElement | null {
  const original = controller.programs[index]
  // the instance's own controller as the choices spell it ('' for the default), so a name in another case is the same
  const originalPlc = choiceOf(plcs, original?.plc)
  const [plc, setPlc] = useState(originalPlc)
  const [name, setName] = useState(original?.name ?? '')
  const [runs, setRuns] = useState(original?.type ?? '')
  const [task, setTask] = useState(original?.task ?? '')
  const [error, setError] = useState<string | null>(null)
  if (!original) return null
  const runsTopLevel = original.type === undefined
  // one row runs the code outside every PROGRAM; another can take that over only once none does
  const canRunTopLevel = runsTopLevel || !controller.programs.some((p) => p.type === undefined)
  const typeName = original.type === undefined ? undefined : types.find((t) => t.toUpperCase() === original.type!.toUpperCase())
  const taskName = controller.tasks.find((t) => original.task !== undefined && t.name.toUpperCase() === original.task.toUpperCase())?.name
  // ...and a row running top-level statements cannot stop, or nothing would run them
  const pinned = pinnedWhy(controller, index, topLevelStatements)
  // with controllers beside the default one, the task list is grouped by controller, which is how an instance changes controller
  const grouped = !!plcs && (plcs.named.length > 0 || controller.tasks.some((k) => k.plc !== undefined) || original.plc !== undefined)
  const dirty = name.trim() !== original.name || runs !== (original.type ?? '') || task !== (original.task ?? '') || plc !== originalPlc
  // a group per controller: the default, the listed ones, and any the table names that the project does not list
  // (the organizer's "not set up"), so every task and every-step choice the table holds has an option to show it
  const groups = plcs
    ? [
        { name: '', label: t(M.plcDefault, { name: plcs.defaultName }) },
        ...plcs.named.map((c) => ({ name: c.name, label: c.simulated ? c.name : t(M.plcOnPlc, { name: c.name }) })),
        ...[...controller.tasks.map((k) => k.plc), original.plc]
          .map((n) => choiceOf(plcs, n))
          .filter((n, i, all) => n !== '' && !plcs.named.some((c) => c.name === n) && all.indexOf(n) === i)
          .map((n) => ({ name: n, label: t(M.missing, { name: n }) })),
      ]
    : []
  const commit = (close: boolean): void => {
    if (readOnly) return onClose()
    const to = name.trim()
    const why = to === original.name ? null : programNameError(controller, index, to)
    if (why) return setError(why)
    setError(null)
    if (dirty) {
      // a program's tags are addressed `Instance.Tag`, so its rename carries the scene's wiring along
      const renamed = to === original.name ? { controller, renames: [] as TagRename[] } : renameProgram(source, controller, index, to)
      let next = renamed.controller
      if (runs !== (original.type ?? '')) next = setProgramType(next, index, runs === '' ? null : runs)
      if (task !== (original.task ?? '') || plc !== originalPlc) next = setProgramTask(next, index, task === '' ? null : task, plc === '' ? undefined : plc)
      onCommit(next, renamed.renames, t(M.editProgram, { name: original.name }))
    }
    if (close) onClose()
  }
  const off = !!readOnly

  // what a rename here does to the scene, in the two cases it can be in
  const hint =
    original.type === undefined
      ? t(M.hintTopLevel)
      : t(M.hintInstance, { name: name.trim() || original.name })

  return (
    <Shell title={t(M.programTitle, { name: original.name })} testid="program-props" error={error} dirty={dirty} readOnly={readOnly} onOk={() => commit(true)} onApply={() => commit(false)} onClose={onClose}>
      <div className="props-grid">
        <label htmlFor="program-props-name">{t(M.name)}</label>
        <input id="program-props-name" data-testid="program-props-name" autoFocus spellCheck={false} disabled={off} value={name} onFocus={(e) => e.currentTarget.select()} onChange={(e) => { setError(null); setName(e.target.value) }} />
        <label htmlFor="program-props-runs">{t(M.runs)}</label>
        <select
          id="program-props-runs"
          data-testid="program-props-runs"
          disabled={off || pinned !== null}
          value={runs === '' ? '' : (typeName ?? runs)}
          title={pinned ?? t(M.runsTitle)}
          onChange={(e) => setRuns(e.target.value)}
        >
          {canRunTopLevel && <option value="">{t(M.topLevel)}</option>}
          {!runsTopLevel && typeName === undefined && <option value={original.type}>{t(M.missing, { name: original.type! })}</option>}
          {types.map((type) => (
            <option key={type} value={type}>
              {/* i18n-ok: IEC keyword and the PROGRAM's name */}
              PROGRAM {type}
            </option>
          ))}
        </select>
        <label htmlFor="program-props-task">{t(M.task)}</label>
        {grouped ? (
          // each controller runs its own tasks, so the task picked is the controller picked: one choice, not two
          <select
            id="program-props-task"
            data-testid="program-props-task"
            disabled={off}
            title={t(M.taskTitleGrouped)}
            value={task === '' ? EVERY_STEP + plc : (taskName ?? task)}
            onChange={(e) => {
              const v = e.target.value
              setTask(v.startsWith(EVERY_STEP) ? '' : v)
              setPlc(v.startsWith(EVERY_STEP) ? v.slice(EVERY_STEP.length) : '')
            }}
          >
            {groups.map((g) => (
              <optgroup key={g.name} label={g.label}>
                {controller.tasks
                  .filter((k) => choiceOf(plcs, k.plc) === g.name)
                  .map((k) => (
                    <option key={k.name} value={k.name}>
                      {/* i18n-ok: a task name and its interval in ms */}
                      {k.name} ({k.intervalMs} ms)
                    </option>
                  ))}
                {/* the code outside every PROGRAM runs only on the default controller */}
                {(g.name === '' || runs !== '') && <option value={EVERY_STEP + g.name}>{t(M.everyStepOn, { name: g.name || plcs!.defaultName })}</option>}
              </optgroup>
            ))}
            {original.task !== undefined && taskName === undefined && <option value={original.task}>{t(M.missing, { name: original.task })}</option>}
          </select>
        ) : (
          <select id="program-props-task" data-testid="program-props-task" disabled={off} value={task === '' ? '' : (taskName ?? task)} onChange={(e) => setTask(e.target.value)}>
            {controller.tasks.map((k) => (
              <option key={k.name} value={k.name}>
                {/* i18n-ok: a task name and its interval in ms */}
                {k.name} ({k.intervalMs} ms)
              </option>
            ))}
            {original.task !== undefined && taskName === undefined && <option value={original.task}>{t(M.missing, { name: original.task })}</option>}
            <option value="">{t(M.everyStep)}</option>
          </select>
        )}
      </div>
      <p className="props-hint">{hint}</p>
    </Shell>
  )
}
