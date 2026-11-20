// The tripwire. Slice 1 makes the command registry translatable; these tests are what stop it from
// quietly becoming untranslatable again as commands are added.
//
// Two different guarantees, and the distinction is the point:
//
//  - LABELS are structural. COMMANDS is built only by mapping localizeCommand over COMMAND_DEFS, so a
//    new command's label is registered whether or not its author thought about i18n. The test proves
//    the property (flip the locale, every label moves) rather than trusting the code path.
//  - PROSE inside run() bodies is NOT structural - a confirm()/alert()/prompt() call is invisible to
//    the transform. That one is guarded by reading this module's own source, which is the only way to
//    catch a string that was never handed to core/i18n in the first place.

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { messageCatalog, messageSource, setLocale } from '../core/i18n'
import { COMMANDS, desktopMenuModel, groupLabel } from './commands'

const source = readFileSync(new URL('./commands.ts', import.meta.url), 'utf8')

/** Every message, prefixed - a locale that translates the whole catalog. */
const markAll = (): Map<string, string> =>
  new Map([...messageCatalog()].map(([id, text]) => [id, `[xx]${text}`]))

afterEach(() => setLocale('en', null))

describe('command labels go through the seam', () => {
  it('registers every command label under an id derived from the command id', () => {
    const catalog = messageCatalog()
    for (const cmd of COMMANDS) {
      expect(catalog.has(`command.${cmd.id}.label`), `${cmd.id} has no registered label message`).toBe(true)
    }
  })

  it('keeps each English label reachable under a locale (the palette searches it too)', () => {
    setLocale('xx', markAll())
    const undo = COMMANDS.find((c) => c.id === 'edit.undo')!
    expect(undo.label).toBe('[xx]Undo')
    expect(messageSource('command.edit.undo.label')).toBe('Undo')
  })

  it('English is unchanged with no locale installed', () => {
    // slice 1 must move zero pixels
    expect(COMMANDS.find((c) => c.id === 'file.newProject')?.label).toBe('New Project…')
    expect(COMMANDS.find((c) => c.id === 'edit.undo')?.label).toBe('Undo')
  })

  it('every label follows a locale change - the structural check', () => {
    // If a command is ever built outside localizeCommand, its label stays English here and this fails.
    // That is the guarantee: not "we remembered to call t()", but "there is no way not to".
    const before = COMMANDS.map((c) => c.label)
    setLocale('xx', markAll())
    const after = COMMANDS.map((c) => c.label)
    for (const [i, cmd] of COMMANDS.entries()) {
      expect(after[i], `${cmd.id} did not follow the locale`).toBe(`[xx]${before[i]}`)
    }
  })

  it('reads live, so a locale installed after boot needs no re-registration', () => {
    const cmd = COMMANDS.find((c) => c.id === 'sim.run')!
    expect(cmd.label).toBe('Run')
    setLocale('xx', new Map([['command.sim.run.label', 'Starten']]))
    expect(cmd.label).toBe('Starten') // same object, already handed to every surface
  })

  it('keeps the command id as identity - a translated label never moves it', () => {
    setLocale('xx', markAll())
    expect(COMMANDS.map((c) => c.id)).toContain('file.newProject')
    expect(COMMANDS.every((c) => !c.id.startsWith('[xx]'))).toBe(true)
  })
})

describe('group / menu section headings', () => {
  it('translates a declared section, falls back to the raw name for an undeclared one', () => {
    expect(groupLabel('File')).toBe('File')
    setLocale('xx', markAll())
    expect(groupLabel('File')).toBe('[xx]File')
    expect(groupLabel('NotASection')).toBe('NotASection')
  })

  it('carries the translation into the desktop menu model, labels and sections alike', () => {
    setLocale('xx', markAll())
    const model = desktopMenuModel()
    const file = model.find((s) => s.label === '[xx]File')
    expect(file, 'File section title not translated').toBeDefined()
    const newCmd = file?.items?.find((i) => i.id === 'file.newProject')
    expect(newCmd?.label).toBe('[xx]New Project…')
  })
})

describe('prose inside run() bodies', () => {
  it('registers the dialog strings the transform cannot see', () => {
    const catalog = messageCatalog()
    for (const id of [
      'command.file.renameProject.prompt',
      'command.file.saveProject.failed',
      'command.file.linkFolder.failed',
    ]) {
      expect(catalog.has(id), `${id} missing from the catalog`).toBe(true)
    }
  })

  it('the tripwire: no confirm/alert/prompt in commands.ts speaks a bare literal', () => {
    // Adding `alert('Something went wrong')` to a run() body is the one way a user-facing string can
    // still slip past the seam. It has to be caught in the source, because at runtime it is just a
    // string nobody registered. Fix by declaring a message beside the others and passing t(...).
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    const offenders = [...code.matchAll(/\b(confirm|alert|prompt)\(\s*['"`]/g)].map((m) => m[0])
    expect(offenders, `use t(<message>) instead: ${offenders.join(', ')}`).toEqual([])
  })
})
