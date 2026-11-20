import { describe, expect, it } from 'vitest'
import { CHIP_FADE_END, CHIP_FADE_START, NO_VALUE, chipOpacity, chipViews, chipsKey, readoutText } from './annotationChips'
import type { ChipProjection } from './annotationChips'
import { ANNOTATION_ICONS, annotationGlyph, PART_DEFS } from '../core/types'
import { createPart } from '../core/scene/scene'
import { subtreeIds } from '../core/scene/hierarchy'
import type { AnnotationPart, PartInstance } from '../core/types'

const proj = (id: string, over: Partial<ChipProjection> = {}): ChipProjection =>
  ({ id, x: 100, y: 100, visible: true, distance: 5, text: 'Note', glyph: 'ℹ', value: '', selected: false, ...over })

describe('chipOpacity', () => {
  it('is solid up close and gone past the far limit', () => {
    expect(chipOpacity(0)).toBe(1)
    expect(chipOpacity(CHIP_FADE_START)).toBe(1)
    expect(chipOpacity(CHIP_FADE_END)).toBe(0)
    expect(chipOpacity(CHIP_FADE_END + 50)).toBe(0)
  })

  it('fades linearly between the two', () => {
    const mid = (CHIP_FADE_START + CHIP_FADE_END) / 2
    expect(chipOpacity(mid)).toBeCloseTo(0.5, 5)
  })

  it('treats a broken distance as invisible rather than solid', () => {
    expect(chipOpacity(Number.NaN)).toBe(0)
    expect(chipOpacity(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('degenerate range collapses to hidden instead of dividing by zero', () => {
    expect(chipOpacity(10, 5, 5)).toBe(0)
    expect(chipOpacity(10, 20, 5)).toBe(0)
  })
})

describe('readoutText - blank is not zero', () => {
  it('prints an unreadable tag as a dash, never as 0', () => {
    // The rule the whole readout rests on. A bound tag reads 0 through a tag table when the sim is
    // stopped, no program is attached, or the name is misspelled - so the obvious implementation paints
    // a confident `0` on a note wired to nothing, which on a layout looks exactly like a stopped line.
    expect(readoutText(undefined)).toBe(NO_VALUE)
    expect(readoutText(undefined, 2, '/min')).toBe(NO_VALUE) // no unit on a blank: '-- /min' reads as a measurement
  })

  it('a published zero does print - the line really is stopped, and that is a measurement', () => {
    expect(readoutText(0)).toBe('0')
    expect(readoutText(0, 1, 'm/s')).toBe('0.0 m/s')
  })

  it('honours the authored precision and unit', () => {
    expect(readoutText(17.25, 1, '/min')).toBe('17.3 /min')
    expect(readoutText(17.25, 0)).toBe('17')
    expect(readoutText(0.5, 3, 'm')).toBe('0.500 m')
  })

  it('clamps a silly precision instead of throwing (toFixed only accepts 0..100)', () => {
    expect(readoutText(1.5, -3)).toBe('2')
    expect(readoutText(1.5, 99)).toBe('1.500000')
  })

  it('prints a BOOL as ON/OFF, with no unit - a state is not a quantity', () => {
    expect(readoutText(true, 0, 'm/s')).toBe('ON')
    expect(readoutText(false)).toBe('OFF')
  })

  it('passes a STRING tag through', () => {
    expect(readoutText('FAULT')).toBe('FAULT')
  })

  it('prints NaN/Infinity as blank - a broken number must not read as a measurement', () => {
    expect(readoutText(Number.NaN)).toBe(NO_VALUE)
    expect(readoutText(Number.POSITIVE_INFINITY, 2, '%')).toBe(NO_VALUE)
  })
})

describe('chipViews', () => {
  it('keeps a visible, near chip', () => {
    expect(chipViews([proj('a')])).toEqual([{ ...proj('a'), opacity: 1 }])
  })

  it('drops an off-screen chip instead of clamping it to the viewport edge', () => {
    // The tutorial's single placement hint clamps to the edge with an arrow. Doing that for every note
    // turns a plant layout into a ring of arrows around a scene you can no longer see - so off screen is
    // hidden, and this assertion pins that.
    expect(chipViews([proj('a', { visible: false })])).toEqual([])
  })

  it('drops a chip past the fade limit', () => {
    expect(chipViews([proj('a', { distance: CHIP_FADE_END + 1 })])).toEqual([])
  })

  it('drops a chip whose projection is not a finite point', () => {
    expect(chipViews([proj('a', { x: Number.NaN })])).toEqual([])
    expect(chipViews([proj('b', { y: Number.POSITIVE_INFINITY })])).toEqual([])
  })

  it('preserves input order and passes the fade through', () => {
    const mid = (CHIP_FADE_START + CHIP_FADE_END) / 2
    const out = chipViews([proj('a'), proj('b', { distance: mid }), proj('c', { distance: 99 })])
    expect(out.map((v) => v.id)).toEqual(['a', 'b'])
    expect(out[1]!.opacity).toBeCloseTo(0.5, 5)
  })
})

describe('chipsKey', () => {
  it('is stable for a sub-pixel move - an idle camera must not repaint the overlay', () => {
    expect(chipsKey(chipViews([proj('a', { x: 100.2 })]))).toBe(chipsKey(chipViews([proj('a', { x: 100.4 })])))
  })

  it('changes on a real move', () => {
    expect(chipsKey(chipViews([proj('a', { x: 100 })]))).not.toBe(chipsKey(chipViews([proj('a', { x: 140 })])))
  })

  it('changes when a chip appears or disappears', () => {
    expect(chipsKey(chipViews([proj('a')]))).not.toBe(chipsKey(chipViews([proj('a'), proj('b', { x: 200 })])))
    expect(chipsKey(chipViews([proj('a')]))).not.toBe(chipsKey([]))
  })

  it('ignores an imperceptible opacity change but catches a visible one', () => {
    expect(chipsKey(chipViews([proj('a', { distance: 30 })]))).toBe(chipsKey(chipViews([proj('a', { distance: 30.05 })])))
    expect(chipsKey(chipViews([proj('a', { distance: 24 })]))).not.toBe(chipsKey(chipViews([proj('a', { distance: 40 })])))
  })
})

describe('the annotation part type', () => {
  it('creates with the authored defaults and no geometry params', () => {
    const note = createPart('annotation', 'note_1', [1, 1.2, 2]) as AnnotationPart
    expect(note.type).toBe('annotation')
    expect(note.params.text).toBe('Note')
    expect(note.params.icon).toBe('info')
  })

  it('drops at chest height, not on the floor - a note reads against the machine, not the concrete', () => {
    expect(PART_DEFS.annotation.defaultY).toBeGreaterThan(1)
  })

  it('offers no resize handles and no thumbnail (there is nothing to size or to photograph)', () => {
    expect(PART_DEFS.annotation.resize).toEqual({})
    expect(PART_DEFS.annotation.glyph).toBeTruthy()
  })

  it('is placeable from the catalog', () => {
    expect(PART_DEFS.annotation.noCatalog).toBeUndefined()
  })

  it('every icon option maps to a glyph, and an unknown value falls back rather than going blank', () => {
    for (const opt of ANNOTATION_ICONS) {
      if (opt.value === 'none') expect(annotationGlyph(opt.value)).toBe('')
      else expect(annotationGlyph(opt.value)).toBeTruthy()
    }
    expect(annotationGlyph('not-an-icon')).toBe(annotationGlyph('info'))
  })

  it('parented to a machine, it rides in that machine\'s SUBTREE - which is what makes a note follow', () => {
    // The whole reason to prefer a parented note over a fixed coordinate. A translate drag applies to
    // `subtreeIds(selection)` (editor/controller/drag.ts), so an annotation being an ordinary part with an
    // ordinary `parent` is all it takes: move the conveyor and the note goes along, instead of staying put
    // and quietly ending up over empty floor.
    const conveyor = { ...createPart('part', 'conv1', [0, 0, 0]), packageId: 'x' } as PartInstance
    const note = { ...(createPart('annotation', 'note_1', [1, 1.2, 0]) as AnnotationPart), parent: 'conv1' }
    const parts: PartInstance[] = [conveyor, note]
    expect(subtreeIds(parts, ['conv1'])).toEqual(['conv1', 'note_1'])
    // ...and an unparented note is not carried by someone else's move
    const free = createPart('annotation', 'note_2', [6, 1.2, 4]) as AnnotationPart
    expect(subtreeIds([...parts, free], ['conv1'])).not.toContain('note_2')
  })

  it('the icon param offers exactly the closed set', () => {
    const spec = PART_DEFS.annotation.params.find((p) => p.key === 'icon')
    expect(spec?.kind).toBe('enum')
    const options = (spec as { options: { value: string }[] }).options
    expect(options.map((o) => o.value)).toEqual(ANNOTATION_ICONS.map((o) => o.value))
  })
})
