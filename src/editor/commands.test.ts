// The registry's own invariants. These are the checks that keep the "one definition" claim true -
// without them the command list can drift from the keymap (a chord hint pointing at nothing) or from
// the desktop menu (an item naming a command that no longer exists), which is exactly the class of
// bug the registry exists to end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_KEYMAP } from '../core/keymap'
import { acceleratorFor, COMMANDS, commandChord, commandDisabledReason, commandEnabled, commandEnabledOn, DESKTOP_MENU, desktopMenuModel, getCommand, menuEnablement, runCommand, runCommandOn, runMenuCommand, setCommandCtx, SIM_SPEEDS } from './commands'
import type { CommandCtx } from './commands'
import { parkSplitOff, readParkedSplitOff } from './project/projectFile'
import { PROJECT_VERSION } from '../core/project/project'
import type { ProjectJSON } from '../core/project/project'
import { SCENE_VERSION } from '../core/types'

// file.exportSplitOff downloads each waiting project: the download is the browser's (a Blob and an <a>), so it is
// recorded here instead, and everything else in projectFile stays real
const downloaded: string[] = []
// Export Project's download, recorded the same way, with what it was told to leave out
const exportedWith: unknown[] = []
vi.mock('./project/projectFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project/projectFile')>()),
  downloadProjectDocument: (p: { name: string }) => {
    downloaded.push(p.name)
    return Promise.resolve()
  },
  downloadProject: (_store: unknown, leaveOut?: unknown) => {
    exportedWith.push(leaveOut ?? {})
    return Promise.resolve()
  },
}))

const keymapIds = new Set(DEFAULT_KEYMAP.map((b) => b.id))

describe('command registry', () => {
  it('has unique ids', () => {
    const seen = new Set<string>()
    for (const cmd of COMMANDS) {
      expect(seen.has(cmd.id), `duplicate command id ${cmd.id}`).toBe(false)
      seen.add(cmd.id)
    }
  })

  it('gives every command a label', () => {
    for (const cmd of COMMANDS) expect(cmd.label.trim().length, cmd.id).toBeGreaterThan(0)
  })

  it('only names chords that core/keymap.ts actually binds', () => {
    for (const cmd of COMMANDS) {
      if (cmd.keys) expect(keymapIds.has(cmd.keys), `${cmd.id} points at missing keymap action ${cmd.keys}`).toBe(true)
    }
  })

  it('never claims a chord twice - the menu registers `accelerator`, the app owns `keys`', () => {
    // Both would mean the keystroke fires the command once via Electron and once via the app's keydown.
    for (const cmd of COMMANDS) expect(!!(cmd.accelerator && cmd.keys), cmd.id).toBe(false)
  })
})

describe('desktop menu', () => {
  it('only references commands that exist', () => {
    for (const section of DESKTOP_MENU) {
      for (const node of section.items ?? []) {
        if ('command' in node) expect(getCommand(node.command), `menu names unknown command ${node.command}`).toBeDefined()
      }
    }
  })

  it('resolves labels and chord hints into the model main renders', () => {
    const model = desktopMenuModel()
    const file = model.find((s) => s.label === 'File')
    expect(file?.items?.some((i) => i.type === 'command' && i.label === 'New Project…')).toBe(true)
    const undo = model.flatMap((s) => s.items ?? []).find((i) => i.id === 'edit.undo')
    // Ctrl+Z shows in the menu but must NOT be registered there: the app's own keydown binds it
    expect(undo?.accelerator).toBe('CmdOrCtrl+Z')
    expect(undo?.register).toBe(false)
    const run = model.flatMap((s) => s.items ?? []).find((i) => i.id === 'sim.run')
    expect(run?.accelerator).toBe('F5')
    expect(run?.register).toBe(true)
  })

  // The transport keeps F5 in the desktop menu and has Ctrl+Enter in the browser, where F5 reloads the page -
  // so each surface must print the chord it actually binds, and the web one must not be the menu's.
  it('prints the transport chord each surface binds: F5 on the desktop, the keymap chord in the browser', () => {
    const run = getCommand('sim.run')!
    const pause = getCommand('sim.pause')!
    const stop = getCommand('sim.stop')!
    expect([commandChord(run, true), commandChord(pause, true), commandChord(stop, true)]).toEqual(['F5', 'F6', 'Shift+F5'])
    for (const cmd of [run, pause, stop]) {
      expect(commandChord(cmd, false), cmd.id).not.toMatch(/F\d/)
      expect(DEFAULT_KEYMAP.some((b) => b.id === cmd.webKeys), cmd.id).toBe(true)
    }
    // a command with no webKeys still shows its accelerator in the browser, as before
    expect(commandChord(getCommand('file.newProject')!, false)).not.toBe('')
  })

  // Two menu items registering one chord is Electron's choice of which fires, i.e. a coin toss per build.
  it('gives each registered chord to exactly one item', () => {
    const owners = new Map<string, string>()
    for (const item of desktopMenuModel().flatMap((s) => s.items ?? [])) {
      if (item.type !== 'command' || !item.accelerator || !item.register) continue
      expect(owners.get(item.accelerator), `${item.accelerator} claimed by ${owners.get(item.accelerator)} and ${item.id}`).toBeUndefined()
      owners.set(item.accelerator, item.id ?? '')
    }
  })

  // Ctrl+S is the project Save on every surface: not a scene download on the desktop, and not left unbound in
  // the browser (where it would open the browser's own "Save page as"). The app binds it (App.tsx), so the menu shows the chord without registering it - registering it there too
  // would fire Save twice.
  it('puts Ctrl+S on Save, bound by the app, and leaves the exports without a chord', () => {
    const items = desktopMenuModel().flatMap((s) => s.items ?? [])
    const save = items.find((i) => i.id === 'file.save')
    expect(save?.label).toBe('Save')
    expect(save?.accelerator).toBe('CmdOrCtrl+S')
    expect(save?.register).toBe(false)
    expect(items.filter((i) => i.accelerator === 'CmdOrCtrl+S').map((i) => i.id)).toEqual(['file.save'])
    for (const id of ['file.exportProject']) {
      expect(items.find((i) => i.id === id), id).toBeDefined()
      expect(items.find((i) => i.id === id)?.accelerator, id).toBeUndefined()
    }
  })

  // One export (format 4): the menu offers no scene file, so there is no Export Scene. Leaving out what the scene
  // does not use is a choice inside Export Project (ExportProjectDialog), asked only when there is something to
  // leave out.
  it('has one export, which asks only when there is something to leave out', () => {
    expect(getCommand('file.exportScene')).toBeUndefined()
    expect(desktopMenuModel().flatMap((s) => s.items ?? []).some((i) => i.id === 'file.exportScene')).toBe(false)
    const exp = getCommand('file.exportProject')!
    const project = (extra: Partial<ProjectJSON>): ProjectJSON => ({ version: PROJECT_VERSION, name: 'P', scene: { version: SCENE_VERSION, parts: [] }, ...extra })
    let asked = 0
    const run = (p: ProjectJSON) =>
      exp.run({ store: { snapshotProject: () => p }, ui: { openProjectExport: () => asked++ } } as unknown as CommandCtx)
    exportedWith.length = 0
    run(project({}))
    expect([asked, exportedWith]).toEqual([0, [{}]]) // nothing to choose: straight to the download, whole
    run(project({ tests: [{ name: 't', duration: 1, checks: [] }] as unknown as ProjectJSON['tests'] }))
    expect([asked, exportedWith.length]).toEqual([1, 1]) // something to choose: the dialog decides, not the command
  })

  // A toolbar icon alone is hidden on the mobile layout and easy to miss on the desktop one, and every
  // other action in that row is also in the menu. Pin the tour's menu entry here so it can't quietly
  // become button-only.
  it('offers the tutorial from a menu, not only a toolbar icon', () => {
    const help = DESKTOP_MENU.find((s) => s.label === 'Help')
    expect(help?.items?.some((n) => 'command' in n && n.command === 'help.tutorial')).toBe(true)
    const cmd = getCommand('help.tutorial')
    expect(cmd?.group).toBe('Help')
    // it builds and tags parts as it goes, so a view-only link must not offer it
    expect(cmd?.enabled?.({ state: { readOnly: true } } as never)).toBe(false)
    expect(cmd?.enabled?.({ state: { readOnly: false } } as never)).toBe(true)
  })

  // A speed reachable only by clicking the toolbar button through the cycle has no menu entry, no palette
  // entry, and no way to jump from 1x to 8x. Each rung is its own command, so this checks the two lists stay
  // in sync: a rung added to SIM_SPEEDS must reach the menu.
  it('offers every speed rung, not just a cycle', () => {
    const sim = DESKTOP_MENU.find((s) => s.label === 'Simulation')
    const listed = (sim?.items ?? []).flatMap((n) => ('command' in n ? [n.command] : []))
    for (const v of SIM_SPEEDS) {
      const id = `sim.speed${String(v).replace('.', '_')}`
      expect(getCommand(id), `no command for ${v}x`).toBeDefined()
      expect(getCommand(id)?.label).toContain(`${v}×`)
      expect(listed, `${v}x is missing from the Simulation menu`).toContain(id)
    }
  })

  it('reports enablement for every command it shows', () => {
    const shown = DESKTOP_MENU.flatMap((s) => s.items ?? []).flatMap((n) => ('command' in n ? [n.command] : []))
    expect(Object.keys(menuEnablement()).sort()).toEqual([...new Set(shown)].sort())
  })
})

describe('accelerators', () => {
  // Electron's stock `windowMenu` role binds Ctrl+W to Close, the chord that closes a tab everywhere else; the Window
  // menu is spelled out and Close keeps a chord one step further away.
  it('keeps the Window menu, and moves Close off Ctrl+W', () => {
    const win = desktopMenuModel().find((s) => s.label === 'Window')
    // spelled out, but still macOS's Window menu (the open-windows list) with its Zoom and Bring All to Front
    expect(win?.role).toBe('window')
    expect(win?.items?.filter((i) => i.type === 'role').map((i) => i.role)).toEqual(['minimize', 'zoom', 'close', 'front'])
    const close = win?.items?.find((i) => i.type === 'role' && i.role === 'close')
    expect(close?.accelerator).toBe('CmdOrCtrl+Shift+W')
  })

  it('runs a menu command by id, by its chord or by its item', () => {
    let ran = 0
    setCommandCtx({ state: { testCount: 1 }, ui: { runTests: () => ran++ } } as unknown as CommandCtx)
    try {
      runMenuCommand('sim.runTests')
      expect(ran).toBe(1)
    } finally {
      setCommandCtx(null)
    }
  })

  it('translates keymap chords into Electron spelling', () => {
    expect(acceleratorFor('edit.redo')).toBe('CmdOrCtrl+Shift+Z')
    expect(acceleratorFor('edit.delete')).toBe('Delete')
    expect(acceleratorFor('ui.commands')).toBe('CmdOrCtrl+Shift+P')
    expect(acceleratorFor('view.distractionFree')).toBe('CmdOrCtrl+Shift+F11')
  })
})

describe('run project tests', () => {
  const runTests = getCommand('sim.runTests')!
  // only the field the rule reads - a full EditorState fixture would add nothing to the assertion
  const ctxWith = (testCount: number): CommandCtx => ({ state: { testCount } }) as unknown as CommandCtx

  it('is offered only when the project carries tests', () => {
    expect(runTests.enabled?.(ctxWith(0))).toBe(false)
    expect(runTests.enabled?.(ctxWith(2))).toBe(true)
  })

  it('goes through the UI seam rather than reaching for the store itself', () => {
    let opened = 0
    runTests.run({ ui: { runTests: () => opened++ } } as unknown as CommandCtx)
    expect(opened).toBe(1)
  })
})

describe('why a command is greyed out', () => {
  // The node test env has no `showDirectoryPicker`, so supportsFolderLink() is false here for the same
  // reason it is false on Safari and Firefox - this exercises the real branch, not a mock of it.
  const ctx = (state: Record<string, boolean>): CommandCtx => ({ state }) as unknown as CommandCtx
  const usable = ctx({ running: false, readOnly: false })

  it('explains the folder commands where the browser has no directory picker', () => {
    for (const id of ['file.linkFolder', 'file.saveProject']) {
      const cmd = getCommand(id)!
      expect(cmd.enabled?.(usable), `${id} should be unavailable without a picker`).toBe(false)
      // The alternative is the point: a limitation with no way forward reads as "this app is broken".
      expect(cmd.disabledReason?.(usable)).toMatch(/Export Project/)
    }
  })

  it('stays quiet when the block is the global one a surface already explains', () => {
    // Running / read-only are the toolbar's own message; a command repeating them would double up.
    for (const id of ['file.linkFolder', 'file.saveProject']) {
      expect(getCommand(id)!.disabledReason?.(ctx({ running: true }))).toBeNull()
      expect(getCommand(id)!.disabledReason?.(ctx({ readOnly: true }))).toBeNull()
    }
  })

  it('reports no reason for a command that is available', () => {
    setCommandCtx(usable)
    try {
      expect(commandDisabledReason('file.openDemo')).toBeNull()
      // and a real one for the disabled folder link, through the helper the surfaces call
      expect(commandDisabledReason('file.linkFolder')).toMatch(/Export Project/)
    } finally {
      setCommandCtx(null)
    }
  })

  it('reports no reason without a context, rather than throwing', () => {
    setCommandCtx(null)
    expect(commandDisabledReason('file.linkFolder')).toBeNull()
    expect(commandDisabledReason('nope.not.a.command')).toBeNull()
  })
})

describe('projects list', () => {
  const projects = getCommand('file.projects')!
  const ctx = (state: Record<string, boolean>): CommandCtx => ({ state }) as unknown as CommandCtx

  // The browser can hold more than one project (editor/project/documentStore.ts), which the projects list shows. It stays
  // available while the sim runs, since it is a list and the actions inside it end the session anyway. It is
  // not offered where the document is not ours to switch: a room’s document is the collab doc, and a
  // view-only link owns nothing.
  it('is offered except where the document is not the browser’s to swap', () => {
    expect(projects.enabled?.(ctx({ collab: false, readOnly: false }))).toBe(true)
    expect(projects.enabled?.(ctx({ running: true }))).toBe(true)
    // a shared project is left for the one opened, as any open project is
    expect(projects.enabled?.(ctx({ collab: true }))).toBe(true)
    expect(projects.enabled?.(ctx({ readOnly: true }))).toBe(false)
  })

  it('goes through the UI seam rather than reaching for the store itself', () => {
    let opened = 0
    projects.run({ ui: { showProjects: () => opened++ } } as unknown as CommandCtx)
    expect(opened).toBe(1)
  })

  // First in the File menu, ahead of New/Open: it is the "which document" question, and everything
  // below it acts on whichever document the answer was.
  it('sits under New Project at the head of the File menu', () => {
    const file = DESKTOP_MENU.find((s) => s.label === 'File')
    const commands = (file?.items ?? []).flatMap((n) => ('command' in n ? [n.command] : []))
    expect(commands.slice(0, 2)).toEqual(['file.newProject', 'file.projects'])
  })
})

describe('import project', () => {
  const importCmd = getCommand('file.importProject')!
  const ctx = (state: Record<string, boolean>): CommandCtx => ({ state }) as unknown as CommandCtx

  // The way back in from Export Project (.oip), which the folder commands actively point at (MSG_NO_PICKER
  // tells a browser with no directory picker to use the .oip export instead). As a command it gets a palette
  // entry and a native File menu item too, not just an icon in the scene switcher - main renders only what
  // DESKTOP_MENU names.
  it('is offered where the document is the browser to swap, and never mid-run', () => {
    expect(importCmd.enabled?.(ctx({ running: false, collab: false, readOnly: false }))).toBe(true)
    // unlike the projects list, which is a list: this one reloads into another document, so a run must stop first
    expect(importCmd.enabled?.(ctx({ running: true }))).toBe(false)
    expect(importCmd.enabled?.(ctx({ collab: true }))).toBe(true)
    expect(importCmd.enabled?.(ctx({ readOnly: true }))).toBe(false)
  })

  it('leaves the global blocks to the surface, and has nothing to say about a shared project', () => {
    // an import from a shared project reloads into the import, leaving the shared project (entryParams.ts)
    // running / view-only are the toolbar's own message (Toolbar.fileBlockedReason) - repeating them doubles up, so the
    // command has no reason of its own at all
    expect(importCmd.disabledReason).toBeUndefined()
  })

  it('goes through the UI seam rather than reaching for the store itself', () => {
    let opened = 0
    importCmd.run({ ui: { openProjectFilePicker: () => opened++ } } as unknown as CommandCtx)
    expect(opened).toBe(1)
  })

  // Beside the export, so the round trip reads as a pair in every menu that renders this list.
  it('sits right above Export Project in the File menu, as in the project menu', () => {
    const items = (DESKTOP_MENU.find((sec) => sec.label === 'File')?.items ?? []).filter((n) => 'command' in n)
    const ids = items.map((n) => ('command' in n ? n.command : ''))
    expect(ids).toContain('file.importProject')
    expect(ids.indexOf('file.exportProject')).toBe(ids.indexOf('file.importProject') + 1)
  })
})

describe('rename project', () => {
  const rename = getCommand('file.renameProject')!
  // only the fields the rule reads
  const ctx = (state: Record<string, boolean>): CommandCtx => ({ state }) as unknown as CommandCtx

  // The project name is what the browser tab and the scene picker’s group header read, so this is the
  // only way to say which document you are in. Its two refusals mirror store.renameProject exactly: a
  // rename during the demo preview would fork the demo (persistProject stashes it), and in a room the
  // collab doc is the document, so the label would not survive a reload.
  it('is refused exactly where the name could not persist', () => {
    expect(rename.enabled?.(ctx({ readOnly: false, demoSession: false, collab: false }))).toBe(true)
    expect(rename.enabled?.(ctx({ readOnly: true }))).toBe(false)
    expect(rename.enabled?.(ctx({ demoSession: true }))).toBe(false)
    expect(rename.enabled?.(ctx({ collab: true }))).toBe(false)
  })

  // Not `editable`: relabelling the container touches no scene, so there is nothing for a
  // running sim to be inconsistent with - and refusing it would only teach that the name is riskier
  // than it is.
  it('stays available while the simulation runs', () => {
    expect(rename.enabled?.(ctx({ running: true }))).toBe(true)
  })

  // It is in the File menu because the toolbar row has no width for the name itself (verify-toolbar-fit
  // sweeps its heaviest state at 1239px): the menu and the palette are how it is reached.
  it('is in the File menu', () => {
    const file = DESKTOP_MENU.find((s) => s.label === 'File')
    expect(file?.items?.some((n) => 'command' in n && n.command === 'file.renameProject')).toBe(true)
  })
})

describe('dispatch', () => {
  it('is inert with no editor mounted, rather than throwing', () => {
    // The native menu can fire before/after the renderer holds a context (boot, reload, teardown).
    expect(() => runCommand('edit.undo')).not.toThrow()
    expect(() => runCommand('nope.not.a.command')).not.toThrow()
  })
})

describe('reload PLC program', () => {
  const reload = getCommand('sim.reloadProgram')!
  // only what the rule reads: the controller answers both questions (editor/program/programReload.ts holds the rule itself)
  const ctxWith = (programOutOfDate: boolean, programReloadBlocker: string | null, reloads: string[] = []): CommandCtx =>
    ({ controller: { programOutOfDate, programReloadBlocker, reloadProgram: () => reloads.push('reload') } }) as unknown as CommandCtx

  // The PLC dock's one button renders this, lit when enabled, so enablement IS the "your edits are not running" cue:
  // it must not be lit for a program that is running as written, however the sim got there.
  it('is offered only when the running program is out of date', () => {
    expect(reload.enabled?.(ctxWith(true, null))).toBe(true)
    expect(reload.enabled?.(ctxWith(false, null))).toBe(false)
    expect(reload.enabled?.({ controller: null } as unknown as CommandCtx)).toBe(false)
  })

  // Each refusal names its own way forward. The two middle ones guard silent failures: Reload with an
  // external PLC connected would do nothing, and in a part scene it would attach the factory program to
  // parts that are not there.
  it('says why it is greyed out, one reason per state', () => {
    expect(reload.disabledReason?.(ctxWith(false, 'stopped'))).toMatch(/Play runs the program/)
    expect(reload.disabledReason?.(ctxWith(false, 'external'))).toMatch(/external PLC/)
    expect(reload.disabledReason?.(ctxWith(false, 'partScene'))).toMatch(/Part Editor/)
    expect(reload.disabledReason?.(ctxWith(false, null))).toMatch(/up to date/)
    expect(reload.disabledReason?.({ controller: null } as unknown as CommandCtx)).toMatch(/stopped/)
  })

  // Dim after a reload that failed to compile: "up to date" would be a lie there, and the two ways it can have failed
  // leave different things driving the line.
  it('says what still runs when the text on screen failed to attach', () => {
    const failed = (programAttachFailure: 'previous' | 'none'): CommandCtx =>
      ({ controller: { programOutOfDate: false, programReloadBlocker: null, programAttachFailure } }) as unknown as CommandCtx
    expect(reload.disabledReason?.(failed('previous'))).toMatch(/still running the previous one/)
    expect(reload.disabledReason?.(failed('none'))).toMatch(/running nothing/)
    // a blocker outranks it: stopped is stopped, whatever the last attach did
    const stopped = { controller: { programOutOfDate: false, programReloadBlocker: 'stopped', programAttachFailure: 'none' } } as unknown as CommandCtx
    expect(reload.disabledReason?.(stopped)).toMatch(/stopped/)
  })

  it('reloads through the controller, and a disabled one is a no-op wherever it is invoked', () => {
    const reloads: string[] = []
    setCommandCtx(ctxWith(false, null, reloads))
    try {
      runCommand('sim.reloadProgram') // Ctrl/Cmd-Enter, a stale menu item: all the same door
      expect(reloads).toEqual([])
      setCommandCtx(ctxWith(true, null, reloads))
      runCommand('sim.reloadProgram')
      expect(reloads).toEqual(['reload'])
    } finally {
      setCommandCtx(null)
    }
  })

  it('sits in the Simulation menu beside the transport, with no chord of its own', () => {
    const sim = DESKTOP_MENU.find((s) => s.label === 'Simulation')
    const listed = (sim?.items ?? []).flatMap((n) => ('command' in n ? [n.command] : []))
    expect(listed.indexOf('sim.reloadProgram')).toBe(listed.indexOf('sim.stop') + 1)
    // Ctrl/Cmd-Enter belongs to the code editor (StCodeEditor), not to the app or the menu
    expect(reload.accelerator).toBeUndefined()
    expect(reload.keys).toBeUndefined()
  })
})

describe('check layout', () => {
  const check = getCommand('sim.checkLayout')!
  const ctxWith = (parts: unknown[]): CommandCtx => ({ state: { scene: { parts } } }) as unknown as CommandCtx

  // Separate from Run Project Tests: that one is gated on the project having tests, and a
  // project with no tests is exactly where an unseated part is most likely to go unnoticed.
  it('is offered whenever there is anything to check, tests or not', () => {
    expect(check.enabled?.(ctxWith([]))).toBe(false)
    expect(check.enabled?.(ctxWith([{ id: 'a' }]))).toBe(true)
  })

  it('does not require a running sim or a controller', () => {
    // no controller and no `running` field at all - the check reads geometry already in memory
    expect(check.enabled?.(ctxWith([{ id: 'a' }]))).toBe(true)
  })

  it('brings the Problems dock forward, where the check lists its findings', () => {
    const revealed: string[] = []
    check.run({ store: { revealPanel: (p: string) => revealed.push(p) } } as unknown as CommandCtx)
    expect(revealed).toEqual(['problems'])
  })
})

// The part commands (part.*): one definition shared by the Scene dock row's icons and menu, the Inspector header and the
// catalog card, rather than a copy in each. They act on the part a surface names, else on the selection's.
describe('part commands', () => {
  const parts = [
    { id: 'robot', type: 'part', packageId: 'oip.six-axis-robot' },
    { id: 'belt', type: 'part', packageId: 'oip.belt-conveyor' },
    { id: 'bld', type: 'building' },
  ]
  const state = (s: Record<string, unknown>) => ({
    scene: { parts },
    selectedIds: [],
    selectedRigNode: null,
    focusedPartId: null,
    readOnly: false,
    ...s,
  })
  const calls: string[] = []
  const store = {
    enterPartFocus: (id: string) => calls.push(`focus ${id}`),
    exitPartFocus: () => calls.push('exit'),
    openBehaviorEditor: (pkg: string) => calls.push(`behavior ${pkg}`),
  }
  const install = (s: Record<string, unknown>): void => setCommandCtx({ store, controller: null, state: state(s) } as unknown as CommandCtx)

  it('act on the one selected custom part, and on nothing for a built-in type or a multi-selection', () => {
    try {
      install({ selectedIds: ['robot'] })
      expect(commandEnabled('part.openScene')).toBe(true)
      install({ selectedIds: ['bld'] })
      expect(commandEnabled('part.openScene')).toBe(false)
      expect(commandEnabled('part.editBehavior')).toBe(false)
      install({ selectedIds: ['robot', 'belt'] })
      expect(commandEnabled('part.editBehavior')).toBe(false)
    } finally {
      setCommandCtx(null)
    }
  })

  it('offer Open Part Editor until the part is open in it, then Close Part Editor', () => {
    try {
      install({ selectedIds: ['robot'], focusedPartId: 'robot' })
      expect(commandEnabled('part.openScene')).toBe(false)
      expect(commandEnabled('part.closeScene')).toBe(true)
      install({ selectedIds: ['robot'] })
      expect(commandEnabled('part.closeScene')).toBe(false)
    } finally {
      setCommandCtx(null)
    }
  })

  it('aim at the part a surface names, selected or not (a Scene dock row icon), and at a package (a catalog card)', () => {
    calls.length = 0
    try {
      install({ selectedIds: ['belt'] })
      runCommandOn('part.openScene', { partId: 'robot' })
      runCommandOn('part.editBehavior', { packageId: 'oip.diverter' })
      // inside the robot's own scene with nothing selected, the part is the open one
      install({ focusedPartId: 'robot' })
      runCommand('part.editBehavior')
      // ...and with one of its nodes selected, that node's part
      install({ selectedRigNode: { partId: 'belt', linkName: 'deck' } })
      runCommand('part.editBehavior')
    } finally {
      setCommandCtx(null)
    }
    expect(calls).toEqual(['focus robot', 'behavior oip.diverter', 'behavior oip.six-axis-robot', 'behavior oip.belt-conveyor'])
    expect(commandEnabledOn('part.openScene', { partId: 'robot' })).toBe(false) // no context installed: nothing to run
  })
})

// A project holds one scene (format 4): there are no commands for a list of scenes, and a scene file is imported as
// a project of its own.
describe('one scene per project', () => {
  /** in-memory Storage (the Node test env has none) */
  function fakeStorage(): Storage {
    const m = new Map<string, string>()
    return {
      getItem: (k) => (m.has(k) ? m.get(k)! : null),
      setItem: (k, v) => void m.set(k, String(v)),
      removeItem: (k) => void m.delete(k),
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() {
        return m.size
      },
    } as Storage
  }
  const state = (s: Record<string, unknown> = {}) => ({ running: false, readOnly: false, collab: null, ...s })
  const ctx = (s: Record<string, unknown> = {}): CommandCtx => {
    const st = state(s)
    return { state: st, store: { getState: () => st } } as unknown as CommandCtx
  }
  const menuCommands = (): string[] => DESKTOP_MENU.flatMap((sec) => sec.items ?? []).flatMap((n) => ('command' in n ? [n.command] : []))

  afterEach(() => {
    vi.unstubAllGlobals()
    downloaded.length = 0
  })

  it('has no scene list to add to, rename or delete from, in the registry or the desktop menu', () => {
    for (const id of ['scene.add', 'scene.rename', 'scene.delete']) {
      expect(getCommand(id), id).toBeUndefined()
      expect(menuCommands(), id).not.toContain(id)
    }
    expect(COMMANDS.filter((c) => c.id.startsWith('scene.')).map((c) => c.id)).toEqual([])
  })

  // A scene file comes in through Import Project, the one door (App.tsx sniffs which it was): there is no separate
  // Open Scene File, which made a scene look like a document of its own.
  it('has one way in for project and scene files: Import Project, on the chord Open used', () => {
    expect(getCommand('file.open')).toBeUndefined()
    expect(menuCommands()).not.toContain('file.open')
    const imp = getCommand('file.importProject')!
    expect(imp.label).toBe('Import Project…')
    expect(imp.accelerator).toBe('CmdOrCtrl+O')
    expect(menuCommands()).toContain('file.importProject')
    let opened = 0
    imp.run({ ...ctx(), ui: { openProjectFilePicker: () => opened++ } } as unknown as CommandCtx)
    expect(opened).toBe(1)
  })

  it("downloads an older project's waiting scenes, offered only while some are waiting, and stops offering once they are", async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const waiting = getCommand('file.exportSplitOff')!
    expect(waiting.label).toBe('Download Split-Off Projects')
    expect(waiting.enabled?.(ctx())).toBe(false)
    const project = (name: string): ProjectJSON => ({ version: PROJECT_VERSION, name, scene: { version: SCENE_VERSION, parts: [] } })
    expect(parkSplitOff([project('Plant - Infeed'), project('Plant - Outfeed')]).ok).toBe(true)
    expect(waiting.enabled?.(ctx())).toBe(true)
    waiting.run(ctx())
    await vi.waitFor(() => expect(readParkedSplitOff()).toEqual([]))
    expect(downloaded).toEqual(['Plant - Infeed', 'Plant - Outfeed'])
    expect(waiting.enabled?.(ctx())).toBe(false)
  })
})
