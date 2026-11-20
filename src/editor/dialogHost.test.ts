import { describe, expect, it } from 'vitest'
import { keyBelongsToTarget } from './dialogHost'

/** a stand-in element: keyBelongsToTarget reads nodeType, tagName, type, isContentEditable and closest() */
function el(tagName: string, opts: { type?: string; editable?: boolean; inRegion?: boolean } = {}) {
  return {
    nodeType: 1,
    tagName,
    type: opts.type ?? (tagName === 'INPUT' ? 'text' : undefined),
    isContentEditable: opts.editable ?? false,
    closest: () => (opts.inRegion ? {} : null),
  }
}
function key(target: unknown, k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) {
  return { target, key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt } as unknown as KeyboardEvent
}

describe('keyBelongsToTarget', () => {
  it('gives text entry every key, chords included', () => {
    for (const target of [el('INPUT'), el('INPUT', { type: 'number' }), el('INPUT', { type: 'search' }), el('TEXTAREA'), el('DIV', { editable: true })]) {
      expect(keyBelongsToTarget(key(target, 'w'))).toBe(true)
      expect(keyBelongsToTarget(key(target, 'z', { ctrl: true }))).toBe(true)
      expect(keyBelongsToTarget(key(target, 'Delete'))).toBe(true)
    }
  })

  it('leaves app shortcuts to a focused checkbox, keeping only Space and Enter', () => {
    const box = el('INPUT', { type: 'checkbox' })
    expect(keyBelongsToTarget(key(box, ' '))).toBe(true)
    expect(keyBelongsToTarget(key(box, 'z', { ctrl: true }))).toBe(false) // undo after toggling it
    expect(keyBelongsToTarget(key(box, 'Delete'))).toBe(false)
    expect(keyBelongsToTarget(key(box, 'w'))).toBe(false)
  })

  it('gives a slider its arrows only', () => {
    const range = el('INPUT', { type: 'range' })
    expect(keyBelongsToTarget(key(range, 'ArrowLeft'))).toBe(true)
    expect(keyBelongsToTarget(key(range, 'w'))).toBe(false)
  })

  it('gives a select every unmodified key (letters jump to an option) but not chords', () => {
    const select = el('SELECT')
    expect(keyBelongsToTarget(key(select, 'w'))).toBe(true)
    expect(keyBelongsToTarget(key(select, 'z', { ctrl: true }))).toBe(false)
  })

  it('gives a button Space and Enter only', () => {
    const button = el('BUTTON')
    expect(keyBelongsToTarget(key(button, ' '))).toBe(true)
    expect(keyBelongsToTarget(key(button, 'Escape'))).toBe(false)
  })

  it('leaves Space on a button to the transport when it asks, but not Enter, a checkbox or a code editor', () => {
    const asks = { spaceOnButton: false }
    expect(keyBelongsToTarget(key(el('BUTTON'), ' '), asks)).toBe(false)
    expect(keyBelongsToTarget(key(el('BUTTON'), 'Enter'), asks)).toBe(true)
    expect(keyBelongsToTarget(key(el('INPUT', { type: 'checkbox' }), ' '), asks)).toBe(true)
    expect(keyBelongsToTarget(key(el('BUTTON', { inRegion: true }), ' '), asks)).toBe(true)
  })

  it('gives a key-owning region (a code editor and its find bar) every key, even on a button', () => {
    const findButton = el('BUTTON', { inRegion: true })
    expect(keyBelongsToTarget(key(findButton, 'Escape'))).toBe(true)
    expect(keyBelongsToTarget(key(findButton, 'Delete'))).toBe(true)
    expect(keyBelongsToTarget(key(findButton, 'z', { ctrl: true }))).toBe(true)
  })

  it('leaves everything else to the app', () => {
    expect(keyBelongsToTarget(key(el('DIV'), 'w'))).toBe(false)
    expect(keyBelongsToTarget(key(null, 'w'))).toBe(false)
  })
})
