import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from './i18n'
import {
  bindingMatches,
  DEFAULT_KEYMAP,
  KEY_GROUPS,
  findKeymapConflicts,
  formatChord,
  keyBelongsToControl,
  keyGroupLabel,
  keyHintText,
  keyLabel,
  matchesChord,
  resolveKeyAction,
  resolveKeymap,
  type KeyEventLike,
} from './keymap'

/** a keydown as the browser reports it. `code` is the physical key, `key` the legend under the
 *  user's layout. The two differ on anything but QWERTY, which is why the table exists. */
function press(code: string, key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }
}

// The rule's cases are pinned through the editor's wrapper (editor/dialogHost.test.ts). This is the press free fly
// asks about: Shift+F, on whatever control a click left focused.
describe('keyBelongsToControl', () => {
  const shiftF = press('KeyF', 'F', { shiftKey: true })

  it('leaves Shift+F to the app on a checkbox, a slider or a button, and to text entry and a select', () => {
    expect(keyBelongsToControl(shiftF, { tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(keyBelongsToControl(shiftF, { tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(keyBelongsToControl(shiftF, { tagName: 'BUTTON' })).toBe(false)
    expect(keyBelongsToControl(shiftF, { tagName: 'DIV' })).toBe(false)
    expect(keyBelongsToControl(shiftF, { tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(keyBelongsToControl(shiftF, { tagName: 'TEXTAREA' })).toBe(true)
    expect(keyBelongsToControl(shiftF, { tagName: 'SELECT' })).toBe(true)
    expect(keyBelongsToControl(shiftF, { tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
})

describe('resolveKeyAction - QWERTY', () => {
  it('maps the tool cluster', () => {
    expect(resolveKeyAction(press('KeyW', 'w'), 'editor')).toBe('tool.move')
    expect(resolveKeyAction(press('KeyE', 'e'), 'editor')).toBe('tool.rotate')
    expect(resolveKeyAction(press('KeyQ', 'q'), 'editor')).toBe('tool.transform')
    expect(resolveKeyAction(press('KeyV', 'v'), 'editor')).toBe('tool.select')
    expect(resolveKeyAction(press('KeyM', 'm'), 'editor')).toBe('tool.ruler')
  })

  it('binds rename to F2, so the scene tree resolves it instead of reading e.key', () => {
    expect(resolveKeyAction(press('F2', 'F2'), 'editor')).toBe('edit.rename')
    expect(resolveKeyAction(press('F2', 'F2', { shiftKey: true }), 'editor')).toBeNull()
  })

  it('binds hide / show to the bare H position, leaving Ctrl+H to ladder replace', () => {
    expect(resolveKeyAction(press('KeyH', 'h'), 'editor')).toBe('edit.toggleVisible')
    expect(resolveKeyAction(press('KeyH', 'h', { ctrlKey: true }), 'editor')).toBeNull()
    expect(resolveKeyAction(press('KeyH', 'h', { ctrlKey: true }), 'ladder')).toBe('ladder.replace')
  })

  it("gives ladder Replace a Mac chord, since the system takes Cmd+H for Hide", () => {
    // a Mac reports the character Option types, not the letter on the key
    expect(resolveKeyAction(press('KeyF', 'ƒ', { metaKey: true, altKey: true }), 'ladder')).toBe('ladder.replace')
    expect(resolveKeyAction(press('KeyH', 'h', { ctrlKey: true }), 'ladder')).toBe('ladder.replace')
  })

  it('matches an Alt chord by position, whatever character Alt makes the key report', () => {
    expect(matchesChord('ctrl+alt+KeyZ', press('KeyZ', 'Ω', { ctrlKey: true, altKey: true }), { match: 'logical' })).toBe(true)
    expect(matchesChord('ctrl+alt+KeyZ', press('KeyW', 'z', { ctrlKey: true, altKey: true }), { match: 'logical' })).toBe(false)
    // without Alt a logical chord still follows the legend
    expect(matchesChord('ctrl+KeyZ', press('KeyW', 'z', { ctrlKey: true }), { match: 'logical' })).toBe(true)
    // a synthetic event has no position to compare
    expect(matchesChord('ctrl+alt+KeyZ', { key: 'z', shiftKey: false, ctrlKey: true, altKey: true, metaKey: false }, { match: 'logical' })).toBe(true)
  })

  it('binds go to definition to F12', () => {
    expect(resolveKeyAction(press('F12', 'F12'), 'editor')).toBe('edit.goToDefinition')
  })

  it('binds back and forward through the jumps to Alt+Left and Alt+Right', () => {
    expect(resolveKeyAction(press('ArrowLeft', 'ArrowLeft', { altKey: true }), 'editor')).toBe('edit.jumpBack')
    expect(resolveKeyAction(press('ArrowRight', 'ArrowRight', { altKey: true }), 'editor')).toBe('edit.jumpForward')
    expect(resolveKeyAction(press('ArrowLeft', 'ArrowLeft'), 'editor')).toBeNull()
  })

  it('keeps Numpad5 working with NumLock off, where key reports "Clear"', () => {
    expect(resolveKeyAction(press('Numpad5', 'Clear'), 'editor')).toBe('view.projection')
    expect(resolveKeyAction(press('KeyO', 'o'), 'editor')).toBe('view.projection')
  })

  it('binds the numpad axis views, Ctrl for the opposite side, with NumLock on or off', () => {
    expect(resolveKeyAction(press('Numpad1', '1'), 'editor')).toBe('view.front')
    expect(resolveKeyAction(press('Numpad1', 'End', { ctrlKey: true }), 'editor')).toBe('view.rear')
    expect(resolveKeyAction(press('Numpad3', 'PageDown'), 'editor')).toBe('view.right')
    expect(resolveKeyAction(press('Numpad3', '3', { ctrlKey: true }), 'editor')).toBe('view.left')
    expect(resolveKeyAction(press('Numpad7', 'Home'), 'editor')).toBe('view.top')
    expect(resolveKeyAction(press('Numpad7', '7', { ctrlKey: true }), 'editor')).toBe('view.bottom')
    // the main row's 1 and Page Down are untouched
    expect(resolveKeyAction(press('Digit1', '1'), 'editor')).toBeNull()
    expect(resolveKeyAction(press('PageDown', 'PageDown'), 'editor')).toBe('place.floor')
  })

  it('resolves the ctrl family', () => {
    expect(resolveKeyAction(press('KeyZ', 'z', { ctrlKey: true }), 'editor')).toBe('edit.undo')
    expect(resolveKeyAction(press('KeyZ', 'z', { ctrlKey: true, shiftKey: true }), 'editor')).toBe('edit.redo')
    expect(resolveKeyAction(press('KeyY', 'y', { ctrlKey: true }), 'editor')).toBe('edit.redo')
    // Cmd is accepted as the same command modifier
    expect(resolveKeyAction(press('KeyD', 'd', { metaKey: true }), 'editor')).toBe('edit.duplicate')
  })
})

describe('resolveKeyAction - non-QWERTY layouts', () => {
  // AZERTY: the physical W position prints Z, the A position prints Q. Comparing e.key would put a
  // French user's Move tool under Z; the table matches the physical key to prevent that.
  it('puts spatial keys under the same physical key on AZERTY', () => {
    expect(resolveKeyAction(press('KeyW', 'z'), 'editor')).toBe('tool.move')
    expect(resolveKeyAction(press('KeyQ', 'a'), 'editor')).toBe('tool.transform')
    expect(resolveKeyAction(press('KeyW', 'z'), 'fly')).toBe('fly.forward')
    expect(resolveKeyAction(press('KeyA', 'q'), 'fly')).toBe('fly.left')
    expect(resolveKeyAction(press('KeyW', 'z'), 'pilot')).toBe('pilot.forward')
  })

  // QWERTZ swaps Y and Z: the grid-snap toggle stays under the physical Y position…
  it('keeps grid snap physical on QWERTZ', () => {
    expect(resolveKeyAction(press('KeyY', 'z'), 'editor')).toBe('snap.grid')
  })

  // …but Ctrl+Z must follow the legend, like every other desktop app: on QWERTZ that is the
  // physical KeyY position.
  it('keeps undo on the printed Z', () => {
    expect(resolveKeyAction(press('KeyY', 'z', { ctrlKey: true }), 'editor')).toBe('edit.undo')
    expect(resolveKeyAction(press('KeyZ', 'y', { ctrlKey: true }), 'editor')).toBe('edit.redo')
  })
})

describe('modifier strictness', () => {
  it('separates G from Shift+G', () => {
    expect(resolveKeyAction(press('KeyG', 'g'), 'editor')).toBe('edit.sideGuards')
    expect(resolveKeyAction(press('KeyG', 'g', { shiftKey: true }), 'editor')).toBe('place.reposition')
    expect(resolveKeyAction(press('KeyG', 'g', { ctrlKey: true }), 'editor')).toBe('edit.group')
    expect(resolveKeyAction(press('KeyG', 'g', { ctrlKey: true, shiftKey: true }), 'editor')).toBe('edit.ungroup')
  })

  it('does not fire a plain binding when Alt is held', () => {
    // Alt+drag is the reposition/face-snap gesture; the tool keys must stay out of its way
    expect(resolveKeyAction(press('KeyC', 'c', { altKey: true }), 'editor')).toBeNull()
    expect(resolveKeyAction(press('KeyF', 'f', { altKey: true }), 'editor')).toBeNull()
  })

  it('keeps Shift+F for free fly, not focus', () => {
    expect(resolveKeyAction(press('KeyF', 'f'), 'editor')).toBe('view.focus')
    expect(resolveKeyAction(press('KeyF', 'f', { shiftKey: true }), 'editor')).toBe('camera.freelook')
  })

  it('matches a modifier-token chord on its own keydown', () => {
    // Shift's own press sets shiftKey; the boost binding must still resolve
    expect(resolveKeyAction({ code: 'ShiftLeft', key: 'Shift', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }, 'fly')).toBe('fly.boost')
    expect(resolveKeyAction(press('Space', ' '), 'fly')).toBe('fly.boost')
  })
})

describe('held movement keys ignore modifier state', () => {
  // Regression: strict modifier matching breaks free fly. Shift is the boost, so a boosted W
  // press carries shiftKey. The keyup of a key pressed before Shift went down carries it too,
  // which would leave the action in the held set forever and the camera stuck moving.
  it('registers movement while boosting', () => {
    expect(resolveKeyAction(press('KeyW', 'w', { shiftKey: true }), 'fly')).toBe('fly.forward')
    expect(resolveKeyAction(press('KeyA', 'a', { shiftKey: true }), 'fly')).toBe('fly.left')
    expect(resolveKeyAction(press('KeyW', 'w', { shiftKey: true }), 'pilot')).toBe('pilot.forward')
  })

  it('resolves the same action whatever the modifiers, so every keydown has a keyup', () => {
    for (const mods of [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true, altKey: true }]) {
      expect(resolveKeyAction(press('KeyS', 's', mods), 'fly'), JSON.stringify(mods)).toBe('fly.back')
    }
  })

  it('exits pilot mode on P, the key that entered it', () => {
    expect(resolveKeyAction(press('KeyP', 'p'), 'pilot')).toBe('pilot.exit')
  })
})

describe('code-less events', () => {
  // A couple of e2e scripts dispatch `new KeyboardEvent('keydown', { key: 'g' })`, which carries no
  // code. Those fall back to the legend: layout-dependent, but it is the only signal present.
  it('falls back to the logical key', () => {
    const e: KeyEventLike = { key: 'g', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }
    expect(resolveKeyAction(e, 'editor')).toBe('edit.sideGuards')
  })
})

describe('modes', () => {
  it('scopes bindings to their mode', () => {
    expect(resolveKeyAction(press('KeyE', 'e'), 'editor')).toBe('tool.rotate')
    expect(resolveKeyAction(press('KeyE', 'e'), 'fly')).toBe('fly.up')
    expect(resolveKeyAction(press('KeyE', 'e'), 'pilot')).toBe('pilot.interact')
  })

  it('never resolves a fixed binding - its handler pre-empts it', () => {
    expect(resolveKeyAction(press('Escape', 'Escape'), 'editor')).toBeNull()
  })
})

describe('the table itself', () => {
  it('has no conflicting chords within a mode', () => {
    expect(findKeymapConflicts()).toEqual([])
  })

  // the panel renders group by group off KEY_GROUPS, so a binding filed under a group missing
  // from that list is dropped from the UI silently: the "undocumented binding" the table
  // exists to prevent
  it('files every binding under a group the panel renders', () => {
    for (const b of DEFAULT_KEYMAP) {
      expect(KEY_GROUPS, `${b.id} is in group "${b.group}"`).toContain(b.group)
    }
  })

  it('gives every binding an id, a label and a group', () => {
    for (const b of DEFAULT_KEYMAP) {
      expect(b.id, `${b.id} label`).toBeTruthy()
      expect(b.label, `${b.id} label`).toBeTruthy()
      expect(b.keys.length, `${b.id} keys`).toBeGreaterThan(0)
    }
  })
})

describe('overrides (the rebinding seam)', () => {
  it('replaces a binding without touching the rest', () => {
    const keymap = resolveKeymap({ 'tool.move': ['KeyH'] })
    expect(resolveKeyAction(press('KeyH', 'h'), 'editor', keymap)).toBe('tool.move')
    expect(resolveKeyAction(press('KeyW', 'w'), 'editor', keymap)).toBeNull()
    expect(resolveKeyAction(press('KeyE', 'e'), 'editor', keymap)).toBe('tool.rotate')
  })

  it('refuses to remap a fixed binding', () => {
    const keymap = resolveKeymap({ 'ui.cancel': ['KeyK'] })
    expect(keymap.find((b) => b.id === 'ui.cancel')?.keys).toEqual(['Escape'])
  })

  it('returns the default table untouched when there are no overrides', () => {
    expect(resolveKeymap()).toBe(DEFAULT_KEYMAP)
  })
})

describe('formatChord', () => {
  it('reads the way a user would say it', () => {
    expect(formatChord('KeyW')).toBe('W')
    expect(formatChord('ctrl+shift+KeyZ')).toBe('Ctrl+Shift+Z')
    expect(formatChord('Period')).toBe('.')
    expect(formatChord('PageDown')).toBe('Page Down')
    expect(formatChord('Numpad5')).toBe('Numpad 5')
    expect(formatChord('ctrl+ArrowUp')).toBe('Ctrl+↑')
    expect(formatChord('ctrl+KeyZ', true)).toBe('⌘Z')
  })
})

describe('bindingMatches (the shortcuts panel search)', () => {
  const byId = (id: string) => DEFAULT_KEYMAP.find((b) => b.id === id)!

  it('matches the label, hint and group, ignoring case', () => {
    expect(bindingMatches(byId('edit.undo'), 'UNDO')).toBe(true)
    expect(bindingMatches(byId('snap.vertex'), 'corner')).toBe(true) // hint: 'hold; drag a corner onto another part'
    expect(bindingMatches(byId('snap.grid'), 'snapping')).toBe(true) // group
    expect(bindingMatches(byId('edit.undo'), 'snapping')).toBe(false)
  })

  it('finds a chord the way the panel prints it, per platform', () => {
    expect(bindingMatches(byId('edit.redo'), 'ctrl+shift+z')).toBe(true)
    expect(bindingMatches(byId('edit.redo'), 'ctrl+y')).toBe(true) // its second chord
    expect(bindingMatches(byId('edit.redo'), '⌘⇧z', true)).toBe(true)
  })

  it('needs every word, in any order', () => {
    expect(bindingMatches(byId('edit.moveUp'), 'slot up')).toBe(true)
    expect(bindingMatches(byId('edit.moveUp'), 'slot down')).toBe(false)
  })

  it('matches everything on an empty or blank query', () => {
    expect(DEFAULT_KEYMAP.every((b) => bindingMatches(b, '') && bindingMatches(b, '   '))).toBe(true)
  })
})

describe('matchesChord', () => {
  it('honours the match mode', () => {
    expect(matchesChord('KeyW', press('KeyW', 'z'))).toBe(true)
    expect(matchesChord('KeyW', press('KeyW', 'z'), { match: 'logical' })).toBe(false)
    expect(matchesChord('KeyZ', press('KeyW', 'z'), { match: 'logical' })).toBe(true)
  })

  it('lets a hold-to-act chord ignore modifier state', () => {
    // Shift+Space must keep boosting: Shift is itself one of the boost keys
    expect(matchesChord('Space', press('Space', ' ', { shiftKey: true }), { match: 'logical' })).toBe(false)
    expect(resolveKeyAction(press('Space', ' ', { shiftKey: true }), 'fly')).toBe('fly.boost')
  })
})

describe('display text (the shortcuts panel)', () => {
  afterEach(() => setLocale('en', null))
  const undo = DEFAULT_KEYMAP.find((b) => b.id === 'edit.undo')!
  const vertex = DEFAULT_KEYMAP.find((b) => b.id === 'snap.vertex')!

  it('is the English source with no locale installed', () => {
    expect(keyLabel(undo)).toBe('Undo')
    expect(keyGroupLabel('Snapping')).toBe('Snapping')
    expect(keyHintText(vertex)).toBe(vertex.hint)
  })

  it('reads the installed locale, by message ids taken from the binding ids', () => {
    setLocale('de', new Map([
      ['keymap.edit.undo.label', 'Rückgängig'],
      ['keymap.group.Edit', 'Bearbeiten'],
      ['keymap.snap.vertex.hint', 'halten; eine Ecke ziehen'],
    ]))
    expect(keyLabel(undo)).toBe('Rückgängig')
    expect(keyGroupLabel('Edit')).toBe('Bearbeiten')
    expect(keyHintText(vertex)).toBe('halten; eine Ecke ziehen')
    // the search finds a row by what is shown, and still by the English
    expect(bindingMatches(undo, 'rückgängig')).toBe(true)
    expect(bindingMatches(undo, 'undo')).toBe(true)
  })
})
