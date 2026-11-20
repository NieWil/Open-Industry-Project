// --- array editors (NumberGrid / Wall rules) ---

import { useState } from 'react'
import type { ReactNode } from 'react'
import { clamp } from '../../../core/math'
import type { BuildingWallRule, WallVariant } from '../../../core/types'
import { ColorField } from './color'
import { NumberField } from './fields'
import { gridDecimals, shiftFoldsAfterRemove } from './shared'
import { ChevronIcon, EyeIcon, FoldIcon, TrashIcon } from '../toolbarIcons'
import { defineMessages, t, type MessageId } from '../../../core/i18n'

const M = defineMessages('inspector.arrays', {
  removeElement: 'Remove element',
  removeElementN: 'Remove element {index}',
  moveUp: 'Move up',
  moveUpN: 'Move element {index} up',
  moveDown: 'Move down',
  moveDownN: 'Move element {index} down',
  captureSetTip: "Set this to the current joint positions. Pose the arm with the viewport gizmo first (revolute in °, prismatic in m)",
  captureAddTip: "Append the current joint positions as a new row. Pose the arm with the viewport gizmo first (revolute in °, prismatic in m)",
  capturePose: 'Capture Pose',
  rowName: 'Name of row {i}',
  unnamed: 'Unnamed',
  showPose: 'Show this pose on the arm',
  showRow: 'Show row {i}',
  addElement: 'Add Element',
  noSuchRow: '(no such row)',
  removeColor: 'Remove color',
  removeColorN: 'Remove color {i}',
  addColor: 'Add Color',
  wallA: 'Wall A',
  wallB: 'Wall B',
  wallC: 'Wall C',
  wallD: 'Wall D',
  dockDoor: 'Dock door',
  personnelDoor: 'Personnel door',
  wallRules: 'Wall rules',
  wall: 'Wall',
  run: 'Run',
  gap: 'Gap',
  count: 'Count',
  start: 'Start',
  openings: 'Openings',
  trailer: 'Trailer',
})

/** shared header for the array editors */
function ArrayHeader({ title, count, open, onToggle, tooltip }: { title: string; count?: number; open: boolean; onToggle: () => void; tooltip?: string }) {
  return (
    <button type="button" className="inspector-group-head" aria-expanded={open} onClick={onToggle} title={tooltip}>
      <span className="inspector-group-caret"><FoldIcon closed={!open} /></span>
      {title}
      {count !== undefined && <span className="array-count">{count}</span>}
    </button>
  )
}

/** the two buttons that swap element `index` with its neighbour; order is the only thing they change */
function MoveButtons({ index, count, disabled, onMove }: { index: number; count: number; disabled: boolean; onMove: (dir: -1 | 1) => void }) {
  return (
    <>
      <button type="button" className="segment-remove" disabled={disabled || index === 0} onClick={() => onMove(-1)} title={t(M.moveUp)} aria-label={t(M.moveUpN, { index })}>
        <ChevronIcon dir="up" size="11px" />
      </button>
      <button type="button" className="segment-remove" disabled={disabled || index === count - 1} onClick={() => onMove(1)} title={t(M.moveDown)} aria-label={t(M.moveDownN, { index })}>
        <ChevronIcon dir="down" size="11px" />
      </button>
    </>
  )
}

/** numbered foldable array element with move and remove buttons */
function ArrayElem({
  index,
  count,
  open,
  onToggle,
  onMove,
  onRemove,
  removeDisabled,
  head,
  actions,
  children,
}: {
  index: number
  /** how many elements the array holds: the last one cannot move down */
  count: number
  open: boolean
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
  removeDisabled: boolean
  /** beside the index: a row's name field (ParamSpec.rowNames) */
  head?: ReactNode
  /** before the remove button: a row's own actions (show the pose) */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="array-elem">
      <div className="array-elem-head">
        <button type="button" className="array-elem-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="inspector-group-caret"><FoldIcon closed={!open} /></span>
          {index}
        </button>
        {head}
        <span className="array-elem-tools">
          {actions}
          <MoveButtons index={index} count={count} disabled={removeDisabled} onMove={onMove} />
          <button
            type="button"
            className="segment-remove"
            disabled={removeDisabled}
            onClick={onRemove}
            title={t(M.removeElement)}
            aria-label={t(M.removeElementN, { index })}
          >
            <TrashIcon size="1em" />
          </button>
        </span>
      </div>
      {open && <div className="array-elem-body">{children}</div>}
    </div>
  )
}

/**
 * A list with more rows than this starts folded, its count in the header: an AGV's 48 waypoints laid open make
 * its Inspector ~7900 px tall, burying everything after them. A long table's rows start folded too, each showing
 * its values on one line, so opening it is a list to scan rather than the same wall again.
 */
const OPEN_UP_TO = 8

/**
 * Per-element fold state, open by default unless told otherwise (resets when another part is selected). Keyed by
 * index, so removing a row must shift the rows after it down one (`removed`), or each would take the state of the
 * row that used to follow it. Two rows that swap places swap their state too (`swapped`).
 */
function useElemFolds(openByDefault = true): [(i: number) => boolean, (i: number) => void, (i: number) => void, (i: number, j: number) => void] {
  const [openEl, setOpenEl] = useState<Record<number, boolean>>({})
  const isOpen = (i: number): boolean => openEl[i] ?? openByDefault
  const toggle = (i: number): void => setOpenEl((o) => ({ ...o, [i]: !(o[i] ?? openByDefault) }))
  const removed = (i: number): void => setOpenEl((o) => shiftFoldsAfterRemove(o, i))
  const swapped = (i: number, j: number): void => setOpenEl((o) => ({ ...o, [i]: o[j] ?? openByDefault, [j]: o[i] ?? openByDefault }))
  return [isOpen, toggle, removed, swapped]
}


/**
 * Generic editor for a `numberList` param (the SDK's typed waypoint/pose table): one collapsible row per
 * entry, each row a strip of `arity` number cells. Add/remove rows; a new row clones the last (or zeros).
 * This is what replaces a raw JSON text box for custom-part waypoints - the value stays structured
 * `number[][]`, so it can't be made malformed by editing.
 */
export function NumberGrid({
  rows,
  arity,
  min,
  max,
  step,
  cellLabels,
  title,
  disabled,
  fixedRows,
  onChange,
  onCapture,
  rowNames,
  onRename,
  onRemoveRow,
  onMoveRow,
  onPreviewRow,
}: {
  rows: readonly number[][]
  arity: number
  min?: number
  max?: number
  step?: number
  cellLabels?: readonly string[]
  title: string
  disabled: boolean
  /** a fixed row count (ParamSpec.rows): the rows are shown as plain strips, with no Add / Remove, and a capture
   *  replaces the row instead of appending one (a robot's idle pose is one row, set rather than grown) */
  fixedRows?: number
  onChange: (next: number[][]) => void
  /** teach-pendant affordance: append the rig's current posed joint values as a new row (jointed custom rigs
   *  whose joint count matches this grid's row width; see controller.captureRigPose) */
  onCapture?: () => void
  /** the rows' names (ParamSpec.rowNames): each row shows an editable name beside its index */
  rowNames?: readonly string[]
  onRename?: (i: number, name: string) => void
  /** removes row i (and keeps what points at it valid); defaults to dropping the row alone */
  onRemoveRow?: (i: number) => void
  /** swaps row i with its neighbour (and keeps what points at either valid); defaults to swapping the rows alone */
  onMoveRow?: (i: number, dir: -1 | 1) => void
  /** pose the part at row i, when the part can show one (a jointed rig whose joint count fits the row) */
  onPreviewRow?: (i: number) => void
}) {
  const long = rows.length > OPEN_UP_TO
  const [open, setOpen] = useState(!long)
  // a named table starts folded: the names say which pose is which, and six numbers a row is a wall. So does a
  // long one, whose folded rows show their values instead of a name (summary below)
  const [elOpen, toggleEl, elRemoved, elSwapped] = useElemFolds(rowNames === undefined && !long)
  // precise enough to show every value as stored (host-written rows carry more than the step), one width for
  // the whole table so its columns line up
  const decimals = gridDecimals(rows, step)
  // a folded, unnamed row's values on one line, as RowSetField writes a row: enough to tell rows apart, the cells
  // themselves one click away
  const summary = (row: readonly number[]): string => row.map((n) => Number(n.toFixed(2))).join(', ')
  const clampCell = (v: number): number => clamp(v, min ?? -Infinity, max ?? Infinity)
  const setCell = (i: number, c: number, v: number): void =>
    onChange(rows.map((row, idx) => (idx === i ? row.map((n, ci) => (ci === c ? clampCell(v) : n)) : [...row])))
  const blankRow = (): number[] => Array.from({ length: arity }, () => clampCell(0))
  const cells = (row: readonly number[], i: number) => (
    <div className="numbergrid-row">
      {Array.from({ length: arity }, (_, c) => (
        <NumberField
          key={c}
          label={cellLabels?.[c] ?? `#${c + 1}`}
          unit=""
          decimals={decimals}
          value={row[c] ?? 0}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={disabled}
          onCommit={(v) => setCell(i, c, v)}
        />
      ))}
    </div>
  )
  if (fixedRows !== undefined) {
    return (
      <div className="array-field">
        <ArrayHeader title={title} open={open} onToggle={() => setOpen(!open)} />
        {open && (
          <div className="array-body">
            {rows.map((row, i) => (
              <div key={i}>{cells(row, i)}</div>
            ))}
            {onCapture && (
              <button
                type="button"
                className="array-add"
                disabled={disabled}
                title={t(M.captureSetTip)}
                onClick={onCapture}
              >
                {t(M.capturePose)}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="array-field">
      <ArrayHeader title={title} count={rows.length} open={open} onToggle={() => setOpen(!open)} />
      {open && (
        <div className="array-body">
          {rows.map((row, i) => (
            <ArrayElem
              key={i}
              index={i}
              count={rows.length}
              open={elOpen(i)}
              onToggle={() => toggleEl(i)}
              onMove={(dir) => {
                elSwapped(i, i + dir)
                if (onMoveRow) onMoveRow(i, dir)
                else onChange(rows.map((_, idx) => [...rows[idx === i ? i + dir : idx === i + dir ? i : idx]!]))
              }}
              onRemove={() => {
                elRemoved(i)
                if (onRemoveRow) onRemoveRow(i)
                else onChange(rows.filter((_, idx) => idx !== i))
              }}
              removeDisabled={disabled}
              head={
                rowNames ? (
                  <input
                    key={rowNames[i] ?? ''}
                    className="array-elem-name"
                    aria-label={t(M.rowName, { i })}
                    defaultValue={rowNames[i] ?? ''}
                    placeholder={t(M.unnamed)}
                    disabled={disabled}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') {
                        e.currentTarget.value = rowNames[i] ?? ''
                        e.currentTarget.blur()
                      }
                    }}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim()
                      if (v !== (rowNames[i] ?? '')) onRename?.(i, v)
                    }}
                  />
                ) : (
                  !elOpen(i) && (
                    <span className="array-elem-summary" title={summary(row)}>
                      {summary(row)}
                    </span>
                  )
                )
              }
              actions={
                onPreviewRow && (
                  <button type="button" className="segment-remove" title={t(M.showPose)} aria-label={t(M.showRow, { i })} onClick={() => onPreviewRow(i)}>
                    <EyeIcon size="1em" />
                  </button>
                )
              }
            >
              {cells(row, i)}
            </ArrayElem>
          ))}
          <button
            type="button"
            className="array-add"
            disabled={disabled}
            onClick={() => onChange([...rows.map((r) => [...r]), rows.length > 0 ? [...rows[rows.length - 1]!] : blankRow()])}
          >
            {t(M.addElement)}
          </button>
          {onCapture && (
            <button
              type="button"
              className="array-add"
              disabled={disabled}
              title={t(M.captureAddTip)}
              onClick={onCapture}
            >
              {t(M.capturePose)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Editor for an arity-1 `numberList` whose rows are indices into another table (ParamSpec.rowsOf): one checkbox
 * per row of that table, so the set can't name a row that isn't there or drift when rows are added. The value
 * written is still `[[i], ...]`, ascending. An index the set holds past the end of the table is kept, shown as
 * missing, so nothing is silently dropped.
 */
export function RowSetField({
  title,
  tooltip,
  selected,
  table,
  names,
  disabled,
  onChange,
}: {
  title: string
  tooltip?: string
  /** the stored set, `[[i], ...]` */
  selected: readonly number[][]
  /** the rows of the table the indices point into */
  table: readonly number[][]
  /** that table's row names (its ParamSpec.rowNames), shown in place of the values */
  names?: readonly string[]
  disabled: boolean
  onChange: (next: number[][]) => void
}) {
  // its rows are the other table's, so it is long when that one is
  const [open, setOpen] = useState(table.length <= OPEN_UP_TO)
  const set = new Set(selected.map((r) => r[0]).filter((n): n is number => typeof n === 'number'))
  const missing = [...set].filter((i) => !(Number.isInteger(i) && i >= 0 && i < table.length)).sort((a, b) => a - b)
  const toggle = (i: number, on: boolean): void => {
    const next = new Set(set)
    if (on) next.add(i)
    else next.delete(i)
    onChange([...next].sort((a, b) => a - b).map((n) => [n]))
  }
  // a row reads as its values, so the checkbox says which pose it is without a trip to the other table
  const summary = (row: readonly number[]): string => row.map((n) => Number(n.toFixed(2))).join(', ')
  return (
    <div className="array-field">
      <ArrayHeader title={title} count={set.size} open={open} onToggle={() => setOpen(!open)} tooltip={tooltip} />
      {open && (
        <div className="array-body">
          {table.map((row, i) => (
            <label key={i} className="field rowset-row">
              <span className="field-label" title={summary(row)}>
                {i}
                <span className="rowset-summary">{names?.[i] || summary(row)}</span>
              </span>
              <span className="field-control">
                <input type="checkbox" checked={set.has(i)} disabled={disabled} onChange={(e) => toggle(i, e.target.checked)} />
              </span>
            </label>
          ))}
          {missing.map((i) => (
            <label key={`m${i}`} className="field rowset-row">
              <span className="field-label">
                {i}
                <span className="rowset-summary">{t(M.noSuchRow)}</span>
              </span>
              <span className="field-control">
                <input type="checkbox" checked disabled={disabled} onChange={() => toggle(i, false)} />
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Editor for a colour list param (ParamSpec.list): one swatch per entry, with remove and add. The value stays the
 * comma-joined `#rrggbb` string the part reads.
 */
export function ColorListField({
  title,
  tooltip,
  value,
  disabled,
  onChange,
}: {
  title: string
  tooltip?: string
  value: string
  disabled: boolean
  onChange: (next: string) => void
}) {
  const entries = value ? value.split(',') : []
  const [open, setOpen] = useState(entries.length <= OPEN_UP_TO)
  const write = (next: string[]): void => onChange(next.join(','))
  return (
    <div className="array-field">
      <ArrayHeader title={title} count={entries.length} open={open} onToggle={() => setOpen(!open)} tooltip={tooltip} />
      {open && (
        <div className="array-body">
          {entries.map((c, i) => (
            <div key={i} className="colorlist-row">
              <ColorField label={`${i}`} value={c} disabled={disabled} onCommit={(v) => write(entries.map((e, j) => (j === i ? v.toLowerCase() : e)))} />
              <MoveButtons index={i} count={entries.length} disabled={disabled} onMove={(dir) => write(entries.map((_, j) => entries[j === i ? i + dir : j === i + dir ? i : j]!))} />
              <button
                type="button"
                className="segment-remove"
                disabled={disabled}
                onClick={() => write(entries.filter((_, j) => j !== i))}
                title={t(M.removeColor)}
                aria-label={t(M.removeColorN, { i })}
              >
                <TrashIcon size="1em" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="array-add"
            disabled={disabled}
            onClick={() => write([...entries, entries[entries.length - 1] ?? '#ffffff'])}
          >
            {t(M.addColor)}
          </button>
        </div>
      )}
    </div>
  )
}

/** each option's label is a message id, resolved where it renders */
const WALL_RULE_OPTIONS: { value: WallVariant; label: MessageId }[] = [
  { value: 'A', label: M.wallA },
  { value: 'B', label: M.wallB },
  { value: 'C', label: M.wallC },
  { value: 'D', label: M.wallD },
  { value: 'dock_door', label: M.dockDoor },
  { value: 'personnel_door', label: M.personnelDoor },
]

/**
 * Array[BuildingWallRule] editor: each rule paints a wall variant (or
 * a dock or personnel door) over the default Wall_D across a run/gap/count/start pattern on the
 * perimeter. Dock-door rules also expose openings + a trailer toggle.
 */
export function WallRuleArray({
  rules,
  disabled,
  onChange,
}: {
  rules: readonly BuildingWallRule[]
  disabled: boolean
  onChange: (next: BuildingWallRule[]) => void
}) {
  const [open, setOpen] = useState(rules.length <= OPEN_UP_TO)
  const [elOpen, toggleEl, elRemoved, elSwapped] = useElemFolds()
  const set = (i: number, patch: Partial<BuildingWallRule>): void =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const intField = (label: string, key: 'run' | 'gap' | 'count' | 'start', i: number, min: number): ReactNode => (
    <NumberField
      label={label}
      unit=""
      decimals={0}
      value={rules[i]![key]}
      min={min}
      step={1}
      disabled={disabled}
      onCommit={(v) => set(i, { [key]: Math.max(min, Math.round(v)) })}
    />
  )
  return (
    <div className="array-field">
      <ArrayHeader title={t(M.wallRules)} count={rules.length} open={open} onToggle={() => setOpen(!open)} />
      {open && (
        <div className="array-body">
          {rules.map((r, i) => (
            <ArrayElem
              key={i}
              index={i}
              count={rules.length}
              open={elOpen(i)}
              onToggle={() => toggleEl(i)}
              onMove={(dir) => {
                elSwapped(i, i + dir)
                onChange(rules.map((_, idx) => rules[idx === i ? i + dir : idx === i + dir ? i : idx]!))
              }}
              onRemove={() => {
                elRemoved(i)
                onChange(rules.filter((_, idx) => idx !== i))
              }}
              removeDisabled={disabled}
            >
              <label className="field">
                <span className="field-label">{t(M.wall)}</span>
                <span className="field-control">
                  <select value={r.wall} disabled={disabled} onChange={(e) => set(i, { wall: e.target.value as WallVariant })}>
                    {WALL_RULE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.label)}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              {intField(t(M.run), 'run', i, 1)}
              {intField(t(M.gap), 'gap', i, 0)}
              {intField(t(M.count), 'count', i, 0)}
              {intField(t(M.start), 'start', i, 0)}
              {r.wall === 'dock_door' && (
                <>
                  <label className="field">
                    <span className="field-label">{t(M.openings)}</span>
                    <span className="field-control">
                      <select value={String(r.doorCount)} disabled={disabled} onChange={(e) => set(i, { doorCount: Number(e.target.value) })}>
                        <option value="1">1</option>
                        <option value="2">2</option>
                      </select>
                    </span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t(M.trailer)}</span>
                    <span className="field-control">
                      <input type="checkbox" checked={r.trailer} disabled={disabled} onChange={(e) => set(i, { trailer: e.target.checked })} />
                    </span>
                  </label>
                </>
              )}
            </ArrayElem>
          ))}
          <button
            type="button"
            className="array-add"
            disabled={disabled}
            onClick={() => onChange([...rules, { wall: 'B', run: 1, gap: 1, count: 0, start: 0, doorCount: 1, trailer: true }])}
          >
            {t(M.addElement)}
          </button>
        </div>
      )}
    </div>
  )
}
