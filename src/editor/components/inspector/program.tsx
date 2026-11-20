// --- the program editor: a `numberList` declared a ParamSpec.program, shown as programs of steps ---
//
// A robot's jobs are one table of `[job, op, ...args]` rows. Shown as a grid of numbers they are unreadable, so this
// draws each program as a card of steps, one line per step that reads as the step does ("Move  Pick  Stop"), with
// the step being run highlighted while the scene runs. Every edit goes through programLogic.ts and writes the whole
// table (and the names, when they change) as one undo step.

import { useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ProgramArg, ProgramSpec } from '../../../core/parts/partApi'
import { ChevronIcon, CopyIcon, FoldIcon, TrashIcon } from '../toolbarIcons'
import { SpinSlider } from './fields'
import {
  addProgram,
  addStep,
  changeOp,
  duplicateProgram,
  duplicateStep,
  moveStep,
  opOf,
  programViews,
  removeProgram,
  removeStep,
  setArg,
  uniqueName,
} from './programLogic'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.program', {
  rowN: 'Row {n}',
  jobN: 'Job {n}',
  rowMissing: 'That row is no longer in the table. Pick another.',
  missing: '(missing)',
  noJobs: 'No jobs yet. Until there is one, the command tag moves the arm to a single waypoint.',
  collapseJob: 'Collapse job',
  expandJob: 'Expand job',
  commandN: 'The PLC runs this job with command {n}',
  jobName: 'Job name',
  running: 'running',
  steps: { one: '{count} step', other: '{count} steps' },
  duplicateJob: 'Duplicate job',
  duplicateNamed: 'Duplicate {name}',
  copyName: '{name} copy',
  deleteJob: 'Delete job (the jobs after it move up a number)',
  deleteNamed: 'Delete {name}',
  step: 'Step',
  unknown: '(unknown)',
  moveUp: 'Move up',
  moveStepUp: 'Move step up',
  moveDown: 'Move down',
  moveStepDown: 'Move step down',
  duplicateStep: 'Duplicate step',
  duplicate: 'Duplicate',
  deleteStep: 'Delete step',
  delete: 'Delete',
  addStep: 'Add step',
  addStepOption: '+ Add step',
  addJob: 'Add Job',
})

/** a table a `row` argument points into: its rows and their names */
export interface ProgramTable {
  rows: readonly number[][]
  names: readonly string[]
}

export interface ProgramFieldProps {
  title: string
  tooltip?: string
  program: ProgramSpec
  arity: number
  rows: readonly number[][]
  names: readonly string[]
  /** the table a `row` argument names (ParamSpec.program ops' `{ kind: 'row', of }`) */
  table: (key: string) => ProgramTable
  /** the tag a `choice` option's `param` is bound to, '' when unbound */
  tagOf: (param: string) => string
  /** the table row being run right now (the part's ctx.report), or undefined when nothing is */
  activeRow?: number
  disabled: boolean
  /** writes the table, and the names when they are passed, as one edit */
  onChange: (rows: number[][], names?: string[]) => void
  /** pose the part at row `index` of table `of` (a Move step's waypoint), when the part can show one */
  onPreview?: (of: string, index: number) => void
}

// a hue per op, by its position in the declaration: the steps of a job read at a glance as move / grip / wait
// (the op name is drawn in its hue, so the light theme takes a darker twin: the amber and cyan read at ~2:1 on white)
const OP_HUES = [
  'light-dark(#1f6fd1, #4a8fe7)',
  'light-dark(#1a7f37, #3fb950)',
  'light-dark(#9a6700, #e0a32e)',
  'light-dark(#8250df, #a371f7)',
  'light-dark(#1b7c83, #39c5cf)',
  'light-dark(#cf222e, #e5534b)',
]

const rowLabel = (tbl: ProgramTable, i: number): string => tbl.names[i] || t(M.rowN, { n: i })

export function ProgramField({ title, tooltip, program, arity, rows, names, table, tagOf, activeRow, disabled, onChange, onPreview }: ProgramFieldProps) {
  const [open, setOpen] = useState(true)
  // jobs start folded: a step is ~22 elements (its selects carry every op and waypoint), so the demo robot's four
  // open jobs were ~500 of its Inspector's ~1100 and made selecting it hitch. The head still says how many steps
  // and which job is running.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const views = programViews(rows, names)
  const jobName = (p: number): string => names[p] || t(M.jobN, { n: p + 1 })
  const namesFor = (n: number): string[] => Array.from({ length: n }, (_, i) => names[i] ?? '')

  const toggleJob = (p: number): void =>
    setOpened((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  const rename = (p: number, name: string): void => {
    const next = namesFor(Math.max(views.length, p + 1))
    next[p] = name.trim()
    onChange(rows.map((r) => [...r]), next)
  }
  const selectStep = (row: number, values: readonly number[]): void => {
    setSelected(row)
    const op = opOf(program, values[1]!)
    const j = (op?.args ?? []).findIndex((a) => a.kind === 'row')
    const a = op?.args?.[j]
    const index = values[2 + j]!
    if (onPreview && a?.kind === 'row' && index >= 0 && index < table(a.of).rows.length) onPreview(a.of, index)
  }

  const argControl = (a: ProgramArg, value: number, row: number, j: number, opLabel: string) => {
    const set = (v: number): void => onChange(setArg(rows, row, j, v))
    const name = a.label ?? opLabel
    if (a.kind === 'number')
      return (
        <span className="prog-arg prog-arg-number" key={j} title={a.label}>
          <SpinSlider
            value={value}
            decimals={a.step !== undefined && a.step < 1 ? Math.min(3, String(a.step).split('.')[1]?.length ?? 1) : 0}
            unit={a.unit}
            min={a.min}
            max={a.max}
            step={a.step}
            disabled={disabled}
            compact
            onCommit={set}
          />
        </span>
      )
    if (a.kind === 'row') {
      const tbl = table(a.of)
      const missing = !(Number.isInteger(value) && value >= 0 && value < tbl.rows.length)
      return (
        <select
          key={j}
          className={`prog-arg prog-arg-row${missing ? ' prog-missing' : ''}`}
          aria-label={name}
          title={missing ? t(M.rowMissing) : a.label}
          value={missing ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => set(Number(e.target.value))}
        >
          {missing && <option value="">{t(M.missing)}</option>}
          {tbl.rows.map((_, i) => (
            <option key={i} value={i}>
              {rowLabel(tbl, i)}
            </option>
          ))}
        </select>
      )
    }
    return (
      <select key={j} className="prog-arg prog-arg-choice" aria-label={name} title={a.label} value={String(value)} disabled={disabled} onChange={(e) => set(Number(e.target.value))}>
        {a.options.map((o) => {
          const tag = o.param ? tagOf(o.param) : ''
          return (
            <option key={o.value} value={o.value}>
              {tag ? `${o.label} · ${tag}` : o.label}
            </option>
          )
        })}
      </select>
    )
  }

  const stopRowClick = (e: ReactMouseEvent) => e.stopPropagation()

  return (
    <div className="array-field prog-field">
      <button type="button" className="inspector-group-head" aria-expanded={open} onClick={() => setOpen(!open)} title={tooltip}>
        <span className="inspector-group-caret">
          <FoldIcon closed={!open} />
        </span>
        {title}
        <span className="array-count">{views.length}</span>
      </button>
      {open && (
        <div className="prog-body">
          {views.length === 0 && <p className="prog-empty">{t(M.noJobs)}</p>}
          {views.map((v) => {
            const isOpen = opened.has(v.index)
            const running = v.steps.some((s) => s.row === activeRow)
            return (
              <div key={v.index} className={`prog-job${running ? ' prog-job-running' : ''}`} data-job={v.index}>
                <div className="prog-job-head">
                  <button type="button" className="prog-job-caret" aria-expanded={isOpen} aria-label={t(isOpen ? M.collapseJob : M.expandJob)} onClick={() => toggleJob(v.index)}>
                    <FoldIcon closed={!isOpen} />
                  </button>
                  <span className="prog-job-num" title={t(M.commandN, { n: v.index + 1 })}>
                    {v.index + 1}
                  </span>
                  <input
                    key={names[v.index] ?? ''}
                    className="prog-job-name"
                    aria-label={t(M.jobName)}
                    defaultValue={names[v.index] ?? ''}
                    placeholder={jobName(v.index)}
                    disabled={disabled}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') {
                        e.currentTarget.value = names[v.index] ?? ''
                        e.currentTarget.blur()
                      }
                    }}
                    onBlur={(e) => {
                      if (e.currentTarget.value.trim() !== (names[v.index] ?? '')) rename(v.index, e.currentTarget.value)
                    }}
                  />
                  {running && <span className="prog-job-live">{t(M.running)}</span>}
                  <span className="prog-job-count">{t(M.steps, { count: v.steps.length })}</span>
                  <button
                    type="button"
                    className="prog-icon"
                    title={t(M.duplicateJob)}
                    aria-label={t(M.duplicateNamed, { name: jobName(v.index) })}
                    disabled={disabled}
                    onClick={() => {
                      const d = duplicateProgram(rows, namesFor(views.length), v.index, uniqueName(t(M.copyName, { name: jobName(v.index) }), names))
                      onChange(d.rows, d.names)
                    }}
                  >
                    <CopyIcon size="12px" />
                  </button>
                  <button
                    type="button"
                    className="prog-icon"
                    title={t(M.deleteJob)}
                    aria-label={t(M.deleteNamed, { name: jobName(v.index) })}
                    disabled={disabled}
                    onClick={() => {
                      const d = removeProgram(rows, namesFor(views.length), v.index)
                      setSelected(null)
                      onChange(d.rows, d.names)
                    }}
                  >
                    <TrashIcon size="12px" />
                  </button>
                </div>
                {isOpen && (
                  <ol className="prog-steps">
                    {v.steps.map((s, k) => {
                      const code = s.values[1]!
                      const opIndex = program.ops.findIndex((o) => o.code === code)
                      const op = program.ops[opIndex]
                      const hue = OP_HUES[Math.max(0, opIndex) % OP_HUES.length]
                      const active = s.row === activeRow
                      return (
                        <li
                          key={s.row}
                          className={`prog-step${active ? ' prog-step-active' : ''}${selected === s.row ? ' prog-step-selected' : ''}`}
                          data-row={s.row}
                          style={{ ['--op-hue' as string]: hue }}
                          onClick={() => selectStep(s.row, s.values)}
                        >
                          <span className="prog-step-num">{k + 1}</span>
                          <select
                            className="prog-op"
                            aria-label={t(M.step)}
                            title={op?.desc}
                            value={String(code)}
                            disabled={disabled}
                            onClick={stopRowClick}
                            onChange={(e) => onChange(changeOp(program, rows, s.row, Number(e.target.value), arity))}
                          >
                            {!op && <option value={String(code)}>{t(M.unknown)}</option>}
                            {program.ops.map((o) => (
                              <option key={o.code} value={o.code}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <span className="prog-args" onClick={stopRowClick}>
                            {(op?.args ?? []).map((a, j) => argControl(a, s.values[2 + j] ?? 0, s.row, j, op!.label))}
                          </span>
                          {selected === s.row && (
                            <span className="prog-step-toolbar" onClick={stopRowClick}>
                              <button type="button" className="prog-tool" title={t(M.moveUp)} aria-label={t(M.moveStepUp)} disabled={disabled || k === 0} onClick={() => { onChange(moveStep(rows, s.row, -1)); setSelected(v.steps[k - 1]!.row) }}>
                                <ChevronIcon dir="up" size="11px" />
                              </button>
                              <button type="button" className="prog-tool" title={t(M.moveDown)} aria-label={t(M.moveStepDown)} disabled={disabled || k === v.steps.length - 1} onClick={() => { onChange(moveStep(rows, s.row, 1)); setSelected(v.steps[k + 1]!.row) }}>
                                <ChevronIcon dir="down" size="11px" />
                              </button>
                              <button type="button" className="prog-tool" aria-label={t(M.duplicateStep)} disabled={disabled} onClick={() => { onChange(duplicateStep(rows, s.row)); setSelected(s.row + 1) }}>
                                <CopyIcon size="11px" /> {t(M.duplicate)}
                              </button>
                              <button
                                type="button"
                                className="prog-tool prog-tool-danger"
                                aria-label={t(M.deleteStep)}
                                disabled={disabled}
                                onClick={() => {
                                  setSelected(null)
                                  onChange(removeStep(rows, s.row))
                                }}
                              >
                                <TrashIcon size="11px" /> {t(M.delete)}
                              </button>
                            </span>
                          )}
                        </li>
                      )
                    })}
                    <li className="prog-add-step">
                      <select
                        aria-label={t(M.addStep)}
                        value=""
                        disabled={disabled}
                        onChange={(e) => {
                          if (e.target.value !== '') onChange(addStep(program, rows, v.index, arity, Number(e.target.value)))
                        }}
                      >
                        <option value="">{t(M.addStepOption)}</option>
                        {program.ops.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </li>
                  </ol>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className="array-add"
            disabled={disabled}
            onClick={() => {
              const n = addProgram(rows, namesFor(views.length), uniqueName(t(M.jobN, { n: views.length + 1 }), names))
              setOpened((s) => new Set(s).add(views.length))
              onChange(n.rows, n.names)
            }}
          >
            {t(M.addJob)}
          </button>
        </div>
      )}
    </div>
  )
}
