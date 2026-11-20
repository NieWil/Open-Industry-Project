import { describe, expect, it } from 'vitest'
import type { ProgramSpec } from '../../../core/parts/partApi'
import type { ParamSpec } from '../../../core/types'
import {
  addProgram,
  addStep,
  changeOp,
  duplicateProgram,
  duplicateStep,
  joinNames,
  moveStep,
  moveTableRow,
  programViews,
  removeProgram,
  removeTableRow,
  splitNames,
  uniqueName,
} from './programLogic'

// the robot's shape: move (waypoint, via), grip (on), wait (seconds)
const PROGRAM: ProgramSpec = {
  names: 'jobNames',
  ops: [
    { code: 1, label: 'Move', args: [{ kind: 'row', of: 'waypoints' }, { kind: 'choice', options: [{ value: 0, label: 'Stop' }, { value: 1, label: 'Pass' }] }] },
    { code: 2, label: 'Grip', args: [{ kind: 'choice', options: [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }] }] },
    { code: 3, label: 'Wait', args: [{ kind: 'number', unit: 's', min: 0, default: 0.5 }] },
  ],
}
const SPECS: ParamSpec[] = [
  { kind: 'numberList', key: 'waypoints', label: 'Waypoints', arity: 2, default: [], rowNames: 'waypointNames' },
  { kind: 'text', key: 'waypointNames', label: 'Names', default: '' },
  { kind: 'numberList', key: 'via', label: 'Via', arity: 1, default: [], rowsOf: 'waypoints' },
  { kind: 'numberList', key: 'jobs', label: 'Jobs', arity: 4, default: [], program: PROGRAM },
]

describe('program editing', () => {
  const rows = [
    [0, 1, 0, 0],
    [0, 2, 1, 0],
    [1, 1, 2, 1],
    [0, 3, 0.5, 0],
  ]

  it('groups steps by program, in row order, and counts a named program with no steps', () => {
    const views = programViews(rows, ['Pick', 'Place', 'Spare'])
    expect(views.map((v) => v.steps.map((s) => s.row))).toEqual([[0, 1, 3], [2], []])
  })

  it('adds a step at the end of its program, with the op defaults, and keeps programs grouped', () => {
    const next = addStep(PROGRAM, rows, 0, 4, 3)
    expect(next).toEqual([[0, 1, 0, 0], [0, 2, 1, 0], [0, 3, 0.5, 0], [0, 3, 0.5, 0], [1, 1, 2, 1]])
  })

  it('moves a step past the other programs rows to its own neighbour, and stops at the ends', () => {
    // row 3 (program 0) moving up skips nothing: its neighbour in program 0 is row 1
    expect(moveStep(rows, 3, -1)[1]).toEqual([0, 3, 0.5, 0])
    expect(moveStep(rows, 0, -1)).toEqual(rows)
    expect(moveStep(rows, 2, 1)).toEqual(rows) // the only step of program 1
  })

  it('keeps the arguments two ops share when a step changes op, and defaults the rest', () => {
    // Move -> Grip: the waypoint (a row) is not a choice, so Grip takes its own default
    expect(changeOp(PROGRAM, rows, 0, 2, 4)[0]).toEqual([0, 2, 1, 0])
    // Wait -> Wait keeps the seconds
    expect(changeOp(PROGRAM, [[0, 3, 2.5, 0]], 0, 3, 4)[0]).toEqual([0, 3, 2.5, 0])
  })

  it('duplicates a step in place and a program at the end', () => {
    expect(duplicateStep(rows, 1)[2]).toEqual([0, 2, 1, 0])
    const d = duplicateProgram(rows, ['Pick', 'Place'], 1, 'Place 2')
    expect(d.names).toEqual(['Pick', 'Place', 'Place 2'])
    expect(d.rows.filter((r) => r[0] === 2)).toEqual([[2, 1, 2, 1]])
  })

  it('removes a program and moves every later one up, names with them', () => {
    const r = removeProgram(rows, ['Pick', 'Place'], 0)
    expect(r.rows).toEqual([[0, 1, 2, 1]])
    expect(r.names).toEqual(['Place'])
  })

  it('adds a program after the last one, padding names for unnamed ones', () => {
    expect(addProgram(rows, [], 'Job 3').names).toEqual(['', '', 'Job 3'])
  })

  it('names round-trip, and trailing blanks are not stored', () => {
    expect(splitNames('a\n\nc')).toEqual(['a', '', 'c'])
    expect(joinNames(['a', '', ''])).toBe('a')
    expect(joinNames([])).toBe('')
    expect(uniqueName('Job', ['Job', 'Job 2'])).toBe('Job 3')
  })
})

describe('removing a row other params point at', () => {
  const params = {
    waypoints: [[0, 0], [1, 1], [2, 2]],
    waypointNames: 'Home\nPick\nPlace',
    via: [[0], [1], [2]],
    jobs: [
      [0, 1, 1, 0], // move to Pick
      [0, 1, 2, 1], // move to Place
      [0, 3, 1, 0], // wait 1 s: its 1 is seconds, not a waypoint, and must not move
    ],
  }

  it('drops the row, its name, and renumbers every pointer after it', () => {
    const patch = removeTableRow(SPECS, params, 'waypoints', 0)
    expect(patch['waypoints']).toEqual([[1, 1], [2, 2]])
    expect(patch['waypointNames']).toBe('Pick\nPlace')
    expect(patch['via']).toEqual([[0], [1]])
    expect(patch['jobs']).toEqual([[0, 1, 0, 0], [0, 1, 1, 1], [0, 3, 1, 0]])
  })

  it('marks a step that moved to the removed row as missing, never re-points it at a neighbour', () => {
    const patch = removeTableRow(SPECS, params, 'waypoints', 1)
    expect(patch['jobs']).toEqual([[0, 1, -1, 0], [0, 1, 1, 1], [0, 3, 1, 0]])
    expect(patch['via']).toEqual([[0], [1]])
  })
})

describe('moving a row other params point at', () => {
  const params = {
    waypoints: [[0, 0], [1, 1], [2, 2]],
    waypointNames: 'Home\nPick',
    via: [[0], [2]],
    jobs: [
      [0, 1, 1, 0], // move to Pick
      [0, 1, 2, 1], // move to the unnamed third row
      [0, 3, 1, 0], // wait 1 s: its 1 is seconds, not a waypoint, and must not move
    ],
  }

  it('swaps the row with its neighbour, names with it, and every pointer follows its row', () => {
    const patch = moveTableRow(SPECS, params, 'waypoints', 1, 1)!
    expect(patch['waypoints']).toEqual([[0, 0], [2, 2], [1, 1]])
    expect(patch['waypointNames']).toBe('Home\n\nPick')
    expect(patch['via']).toEqual([[0], [1]])
    expect(patch['jobs']).toEqual([[0, 1, 2, 0], [0, 1, 1, 1], [0, 3, 1, 0]])
  })

  it('keeps a row set ascending when the swap crosses one of its rows', () => {
    expect(moveTableRow(SPECS, { ...params, via: [[0], [1]] }, 'waypoints', 0, 1)!['via']).toEqual([[0], [1]])
    expect(moveTableRow(SPECS, { ...params, via: [[1]] }, 'waypoints', 1, -1)!['via']).toEqual([[0]])
  })

  it('does nothing at either end of the table', () => {
    expect(moveTableRow(SPECS, params, 'waypoints', 0, -1)).toBeNull()
    expect(moveTableRow(SPECS, params, 'waypoints', 2, 1)).toBeNull()
  })
})
