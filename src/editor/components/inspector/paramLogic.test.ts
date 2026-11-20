import { describe, expect, it } from 'vitest'
import { createPart } from '../../../core/scene/scene'
import { num, tagRef, text } from '../../../core/types'
import type { ColorParamSpec, EnumParamSpec, NumberListParamSpec, ParamSpec, PartInstance, PartRefParamSpec } from '../../../core/types'
import {
  buildGroupTree,
  buildParamTooltip,
  buildSceneTagIndex,
  coercePaste,
  coerceVec3,
  bitCount,
  displayScale,
  isModified,
  knownMarks,
  normalizeNumber,
  pasteCompatible,
  sharedParam,
  shownNumber,
} from './paramLogic'

const ctx = (parts: PartInstance[] = [], targets: string[] = []) => ({ allParts: parts, targetIds: new Set(targets) })

const note = (id: string, params: Record<string, unknown>): PartInstance => {
  const p = createPart('annotation', id, [0, 0, 0])
  return { ...p, params: { ...p.params, ...params } } as PartInstance
}

describe('buildParamTooltip - a tag says what it carries', () => {
  it('names the type and unit after the label, as the row badge does', () => {
    const speedTag: ParamSpec = { kind: 'tagRef', key: 'speedTag', label: 'Speed tag', default: '', dir: 'in', stType: 'REAL', unit: 'm/s' }
    expect(buildParamTooltip(speedTag, 'Speed Tag', 'The program commands belt speed here.').split('\n')[0]).toBe('Speed Tag · REAL, m/s')
    const runTag: ParamSpec = { kind: 'tagRef', key: 'runTag', label: 'Run tag', default: '', dir: 'in', stType: 'BOOL' }
    expect(buildParamTooltip(runTag, 'Run Tag', undefined).split('\n')[0]).toBe('Run Tag · BOOL')
  })
})

describe('pasteCompatible', () => {
  it('allows the same kind, and string-like kinds into each other', () => {
    expect(pasteCompatible('number', 'number')).toBe(true)
    expect(pasteCompatible('pos', 'pos')).toBe(true)
    expect(pasteCompatible('text', 'tagRef')).toBe(true)
    expect(pasteCompatible('color', 'enum')).toBe(true)
  })

  it('refuses unrelated kinds', () => {
    expect(pasteCompatible('pos', 'rot')).toBe(false)
    expect(pasteCompatible('number', 'text')).toBe(false)
    expect(pasteCompatible('numberList', 'wallRules')).toBe(false)
  })
})

describe('coercePaste', () => {
  it('clamps a number to the target range and step, as typing would', () => {
    const height = num('height', 'Height', 0.5, 0.1, 0.6, 0.01, 'm')
    expect(coercePaste(height, 3, ctx())).toBe(0.6)
    expect(coercePaste(height, -1, ctx())).toBe(0.1)
    const count = num('count', 'Count', 1, 0, 10, 1, '')
    expect(coercePaste(count, 2.6, ctx())).toBe(3)
    expect(coercePaste(count, 'x', ctx())).toBeNull()
  })

  it('takes an enum value only when it is one of the options', () => {
    const e: EnumParamSpec = { kind: 'enum', key: 'mode', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
    expect(coercePaste(e, 'b', ctx())).toBe('b')
    expect(coercePaste(e, 'hello world', ctx())).toBeNull()
  })

  it('validates colours and lets an opaque field drop alpha', () => {
    const opaque: ColorParamSpec = { kind: 'color', key: 'c', label: 'C', default: '#ffffff' }
    const alpha: ColorParamSpec = { ...opaque, alpha: true }
    expect(coercePaste(opaque, '#FF0000', ctx())).toBe('#ff0000')
    expect(coercePaste(opaque, '#ff000080', ctx())).toBe('#ff0000')
    expect(coercePaste(alpha, '#FF000080', ctx())).toBe('#ff000080')
    expect(coercePaste(opaque, 'red', ctx())).toBeNull()
  })

  it('accepts any string for text, but no whitespace in a tag', () => {
    expect(coercePaste(text('t', 'T', ''), 'per min', ctx())).toBe('per min')
    const tag = tagRef('tag', 'Tag', 'in')
    expect(coercePaste(tag, 'Motor1', ctx())).toBe('Motor1')
    expect(coercePaste(tag, '', ctx())).toBe('')
    expect(coercePaste(tag, 'per min', ctx())).toBeNull()
  })

  it('takes a part reference only to another existing part', () => {
    const ref: PartRefParamSpec = { kind: 'partRef', key: 'r', label: 'R', default: '' }
    const parts = [note('a', {}), note('b', {})]
    expect(coercePaste(ref, 'b', ctx(parts, ['a']))).toBe('b')
    expect(coercePaste(ref, 'a', ctx(parts, ['a']))).toBeNull() // not itself
    expect(coercePaste(ref, 'gone', ctx(parts, ['a']))).toBeNull()
    expect(coercePaste(ref, '', ctx(parts, ['a']))).toBe('')
  })

  it('takes a table only at the target width, clamping every cell', () => {
    const grid: NumberListParamSpec = { kind: 'numberList', key: 'w', label: 'W', arity: 2, default: [], min: -1, max: 1 }
    expect(coercePaste(grid, [[0.5, 3]], ctx())).toEqual([[0.5, 1]])
    expect(coercePaste(grid, [[1, 2, 3]], ctx())).toBeNull()
    expect(coercePaste(grid, [[1, Number.NaN]], ctx())).toBeNull()
    expect(coercePaste(grid, 'rows', ctx())).toBeNull()
  })

  it('copies the table rather than sharing the clipboard array', () => {
    const grid: NumberListParamSpec = { kind: 'numberList', key: 'w', label: 'W', arity: 1, default: [] }
    const clip = [[1]]
    const out = coercePaste(grid, clip, ctx()) as number[][]
    expect(out).toEqual(clip)
    expect(out[0]).not.toBe(clip[0])
  })
})

describe('coerceVec3', () => {
  it('accepts exactly three finite numbers', () => {
    expect(coerceVec3([1, 2, 3])).toEqual([1, 2, 3])
    expect(coerceVec3([1, 2])).toBeNull()
    expect(coerceVec3([1, 2, Number.POSITIVE_INFINITY])).toBeNull()
    expect(coerceVec3('1,2,3')).toBeNull()
  })
})

describe('normalizeNumber', () => {
  it('keeps integer-step params on the grid and inside the range', () => {
    expect(normalizeNumber(num('n', 'N', 2, 1, 8, 2, ''), 5.2)).toBe(6)
    expect(normalizeNumber(num('n', 'N', 2, 1, 8, 2, ''), 11)).toBe(8)
    expect(normalizeNumber(num('s', 'S', 0, -3, 3, 0.1, ''), 1.234)).toBe(1.234)
  })
})

describe('sharedParam', () => {
  it('reports one value, or mixed', () => {
    expect(sharedParam([note('a', { text: 'x' }), note('b', { text: 'x' })], 'text')).toEqual({ value: 'x', mixed: false })
    expect(sharedParam([note('a', { text: 'x' }), note('b', { text: 'y' })], 'text').mixed).toBe(true)
  })

  it('compares tables by content', () => {
    const a = note('a', { rows: [[1, 2]] })
    const b = note('b', { rows: [[1, 2]] })
    const c = note('c', { rows: [[1, 3]] })
    expect(sharedParam([a, b], 'rows').mixed).toBe(false)
    expect(sharedParam([a, c], 'rows').mixed).toBe(true)
  })
})

describe('isModified', () => {
  it('compares against the spec default', () => {
    const n = num('n', 'N', 1, 0, 2, 0.1, '')
    expect(isModified(n, 1)).toBe(false)
    expect(isModified(n, 1.5)).toBe(true)
    const grid: NumberListParamSpec = { kind: 'numberList', key: 'w', label: 'W', arity: 1, default: [[1]] }
    expect(isModified(grid, [[1]])).toBe(false)
    expect(isModified(grid, [[2]])).toBe(true)
  })
})

describe('buildGroupTree', () => {
  it('nests "A/B" groups and keeps ungrouped fields first', () => {
    const specs: ParamSpec[] = [
      num('a', 'A', 0, 0, 1, 0.1, ''),
      { ...num('b', 'B', 0, 0, 1, 0.1, ''), group: 'Frame' },
      { ...num('c', 'C', 0, 0, 1, 0.1, ''), group: 'Frame/Legs' },
      { ...num('d', 'D', 0, 0, 1, 0.1, ''), group: 'Frame' },
    ]
    const { ungrouped, groups } = buildGroupTree(specs)
    expect(ungrouped.map((s) => s.key)).toEqual(['a'])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.specs.map((s) => s.key)).toEqual(['b', 'd'])
    expect(groups[0]!.children[0]).toMatchObject({ name: 'Legs', path: 'Frame/Legs' })
    expect(groups[0]!.children[0]!.specs.map((s) => s.key)).toEqual(['c'])
  })
})

describe('buildSceneTagIndex', () => {
  it('collects every bound tag once, sorted, with its readers', () => {
    // an annotation's `tag` is a tagRef read by the note ('in')
    const parts = [note('a', { tag: 'Speed' }), note('b', { tag: 'Count' }), note('c', { tag: 'Speed' }), note('d', { tag: '' })]
    const index = buildSceneTagIndex(parts)
    expect(index.suggestions).toEqual(['Count', 'Speed'])
    expect(index.signals.get('Speed')).toMatchObject({ readers: 2, writers: 0 })
  })
})

describe('colour list params (ParamSpec.list)', () => {
  const list: ColorParamSpec = { kind: 'color', key: 'boxColors', label: 'Box colors', default: '', list: true }
  it('paste takes a list in its one spelling, or one colour, and refuses a sentence', () => {
    expect(coercePaste(list, 'FF0000, 00ff00', ctx())).toBe('#ff0000,#00ff00')
    expect(coercePaste(list, '#123456', ctx())).toBe('#123456')
    expect(coercePaste(list, '', ctx())).toBe('')
    expect(coercePaste(list, 'not a colour', ctx())).toBeNull()
  })
})

describe('percent number params (unit %)', () => {
  const pct = { kind: 'number', key: 'filmOpacity', label: 'Film opacity', default: 0.42, min: 0, max: 1, step: 0.01, unit: '%' } as const
  const metres = { kind: 'number', key: 'width', label: 'Width', default: 1, min: 0, max: 3, step: 0.1, unit: 'm' } as const
  it('shows a stored fraction as a percentage, with no float dust', () => {
    expect(displayScale(pct)).toBe(100)
    expect(shownNumber(pct, 0.42)).toBe(42)
    expect(shownNumber(pct, 0.07)).toBe(7)
  })
  it('leaves every other unit alone', () => {
    expect(displayScale(metres)).toBe(1)
    expect(shownNumber(metres, 0.42)).toBe(0.42)
  })
})

describe('knownMarks', () => {
  it('lists every product attribute any package declares, once, sorted', () => {
    const pkgs = [
      { params: { wrapped: { attribute: true }, loadId: { attribute: true }, courses: {} } },
      { params: { wrapped: { attribute: true }, speed: {} } },
      {},
    ]
    expect(knownMarks(pkgs)).toEqual(['loadId', 'wrapped'])
  })
})

describe('bitCount', () => {
  it('takes a literal count, or the named param, clamped to 1..31', () => {
    expect(bitCount(4, {}, 8)).toBe(4)
    expect(bitCount('segments', { segments: 3 }, 8)).toBe(3)
    expect(bitCount('segments', {}, 5)).toBe(5)
    expect(bitCount(99, {}, 8)).toBe(31)
  })
})
