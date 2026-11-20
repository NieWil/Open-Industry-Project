// What the PLC panel (StEditor.tsx) draws inside it from the program: the organizer column (PlcOrganizer.tsx) and the
// Ladder face (LadderView.tsx), and what the organizer's rows DO - adding a block, renaming one, moving a program's tasks
// into the table. They reach the panel through `PlcPanelCtx`, its doors and nothing more; the panel owns what is about
// the program file and the window (the text editor, the block index, the status lines, undo and autosave).

import { checkFor } from '../../program/programWorkerClient'
import { Suspense, lazy, type ReactElement } from 'react'
import type { Controller } from '../../../core/controller'
import { addBlock, blockNameError, deleteBlock, parseDocument, renameBlock, type DocumentEdit, type StBlock } from '../../../plc/document'
import { blockOffset } from '../../program/stReveal'
import { commitProgramAddition, commitTagRename, namedProgramAddition } from '../../program/controllerCommit'
import { controllerFor, declaresConfiguration, defaultController, extractController } from '../../../plc'
import type { TagScope } from '../../../plc/tags'
import type { TagValue } from '../../../plc/types'
import { renameProgramType, type TagRename } from '../../../plc/controllerEdits'
import { deviceTags } from '../../../plc/bindings'
import type { OrganizerFacts } from '../../program/plcOrganizer'
import type { EditorController } from '../../controller'
import type { EditorState, EditorStore } from '../../store/store'
import { useOrganizerDevices } from './plcDevices'
import type { PanelFaults } from './plcFaults'
import type { OrganizerActions } from './PlcOrganizer'
import type { StFileReportData } from './StFileReport'

/**
 * Which face of the program the panel shows. Both are views over the same text, so nothing else depends on it.
 *
 * Derived from the POU the reader went to, because a POU is written in one language: one whose whole body is a LADDER
 * section opens as rungs, anything else as text (StEditor `openBlock`). A program opens on the PROGRAM its controller
 * runs first (ladderMarks.ts `openingFace`), on mount and on every wholesale load. The Text/Ladder switch shows only
 * while some POU holds a section among statements (`mixesLanguages`), the one POU with two faces; a ladder POU's rung
 * text is behind its organizer row's "Show as text".
 *
 * Nothing is remembered between visits. A remembered face is a second opinion about what the panel should show, and it
 * could disagree with the POU under it: the browser that last worked in ladder opened every later program on a sheet,
 * ladder in it or not.
 */
export type PlcFace = 'text' | 'ladder'

/** The panel's doors, for the organizer and the ladder drawn inside it. */
export interface PlcPanelCtx {
  store: EditorStore
  state: EditorState
  controller: EditorController | null

  // ---- the program
  /** the text as the editor holds it now (not the store's last commit) */
  currentSource: () => string
  /** the program the ladder face is drawn from */
  ladderSource: string
  /** the whole program back from the ladder, as one edit */
  applyLadderEdit: (next: string) => void
  /** a block added, renamed or deleted (plc/document.ts), revealed unless told otherwise */
  applyBlockEdit: (edit: DocumentEdit, reveal?: boolean) => void
  /** the controller table changed, with the renames that go with it */
  applyController: (next: Controller, renames: TagRename[], label: string, source?: string) => void
  blocks: readonly StBlock[]
  activeBlock: number
  facts: OrganizerFacts
  /** the table the organizer shows, and what it says about it */
  table: { shown: Controller; ownConfiguration: boolean; problems: readonly string[] }

  // ---- what the panel is
  readOnly: boolean
  readOnlyNote: string
  live: boolean
  face: PlcFace
  setFace: (face: PlcFace) => void

  // ---- going places
  /** open block `i`: the view follows the POU */
  openBlock: (i: number) => void
  /** put the caret on block `i` without changing the face */
  gotoBlock: (i: number) => void
  /** show the text at `offset` (switching to the text face) */
  showText: (offset: number) => void
  /** the routine the organizer asked the ladder to show */
  revealRoutine: number | null
  onRevealedRoutine: () => void
  /** bump to open the organizer's Tasks */
  revealTasks: number
  /** what the running controller faulted on, for the ladder to draw on its elements (plcFaults.ts) */
  faults: PanelFaults
  /** a narrow panel overlays the organizer: picking anything closes it */
  onPicked?: () => void

  // ---- saying things
  showReport: (report: Omit<StFileReportData, 'id'>) => void
  /** "X landed in the program", after an add */
  showLanded: (name: string) => void

  // ---- the running program
  watch: () => Readonly<Record<string, TagValue>> | null | undefined
  /** the instance shown for a PROGRAM that runs as several, by type upper-cased, and picking one */
  monitored: Readonly<Record<string, string>>
  pickInstance: (type: string, instance: string) => void
  /** the running program's forced variables, by watch key (EditorController.plcForces) */
  forces: () => Readonly<Record<string, number | boolean>>
  /** the attached program's bare-name aliases (EditorController.plcAliases) */
  aliases: () => ReadonlyMap<string, string>
  /** hold a variable of the running program at its value (EditorController.forcePlcValue): null when held, else why not */
  force: (key: string) => string | null
  /** release one forced variable */
  releaseForce: (key: string) => void
  /** told when a force is set or released; returns an unsubscribe */
  onForces: (cb: () => void) => () => void
  /** told when a program attaches or detaches; returns an unsubscribe */
  onProgramStatus: (cb: () => void) => () => void
  toggleBit: (key: string) => boolean
  writeLive: (key: string, text: string) => string | null
  /** Add to Watch: a variable onto the watch list, with the Watch dock brought forward */
  addToWatch: (name: string) => void
  /** every PLC tag the scene's parts speak */
  tags: () => string[]
  undo: () => void
  redo: () => void
}

const PlcOrganizer = lazy(() => import('./PlcOrganizer').then((m) => ({ default: m.PlcOrganizer })))
const LadderView = lazy(() => import('./LadderView').then((m) => ({ default: m.LadderView })))

/** What the organizer's rows do, through the panel's doors. */
function organizerActions(ctx: PlcPanelCtx): OrganizerActions {
  return {
    open: ctx.openBlock,
    showAsText: (i) => {
      ctx.setFace('text')
      ctx.gotoBlock(i)
    },
    addBlock: (kind) => {
      const edit = addBlock(ctx.currentSource(), kind)
      const added = parseDocument(edit.source).blocks[edit.index]
      // a TYPE / VAR_GLOBAL block declares no name of its own, so there is nothing to ask: the view goes to it instead.
      // Revealing focuses the code, which must not happen while a name field is opening.
      const nameable = (added?.name ?? '') !== ''
      ctx.applyBlockEdit(edit, !nameable)
      return nameable ? { index: edit.index, name: added!.name } : null
    },
    suggestProgram: (kind) => {
      const s = ctx.store.getState()
      if (!s.controller && declaresConfiguration(s.stProgram)) {
        ctx.showReport({
          headline: 'This program declares its own CONFIGURATION',
          detail: 'Move its tasks into the organizer first ("Edit them here", under Tasks), then add the program there.',
          items: [],
          tone: 'warn',
          keepOnEdit: false,
        })
        return null
      }
      return namedProgramAddition(s.stProgram, s.controller ?? defaultController(s.stProgram, s.stScanMs), undefined, kind).name
    },
    addProgram: (name, kind, task) => {
      const why = commitProgramAddition(ctx.store, name, kind, task)
      if (why === null) ctx.showLanded(name)
      return why
    },
    blockNameError: (i, name) => blockNameError(ctx.currentSource(), i, name),
    renameBlock: (i, name) => {
      const src = ctx.currentSource()
      const renamed = parseDocument(src).blocks[i]
      const edit = renameBlock(src, i, name)
      // A PROGRAM renamed in the code: the controller's instances of it run the new name, and one named after it
      // follows, with its variables' wiring (controllerEdits.renameProgramType), all one undo step. With no table of its own the
      // program runs the default one, whose instance of it is named after it, so its wiring has to follow all the same.
      const state = ctx.store.getState()
      const table = renamed?.kind === 'programPou' && edit.source !== src ? (state.controller ?? controllerFor(src, null, state.stScanMs)) : null
      if (renamed && table) {
        const next = renameProgramType(edit.source, table, renamed.name, name.trim())
        ctx.applyController(next.controller, next.renames, `Rename program ${renamed.name}`, edit.source)
        ctx.showText(blockOffset(edit.source, parseDocument(edit.source).blocks, edit.index))
        return
      }
      ctx.applyBlockEdit(edit)
    },
    deleteBlock: (i) => ctx.applyBlockEdit(deleteBlock(ctx.currentSource(), i)),
    editController: (next, renames, label) => ctx.applyController(next, renames, label),
    // lazy, as the File menu's export is (commands.ts): the PLCopen writer loads only when a file moves
    exportController: (plc, target) =>
      void import('../../program/stFileTransfer')
        .then((m) => m.exportStProgram(ctx.store, target, plc))
        .catch((e: unknown) => console.warn('[oip] exporting the controller failed', e)),
    adoptConfiguration: () => {
      const split = extractController(ctx.store.getState().stProgram)
      if (!split) {
        ctx.showReport({
          headline: 'Could not move the tasks into the organizer',
          detail: 'Its CONFIGURATION says something the task table cannot hold (an event task, say), or the program does not parse yet.',
          items: [],
          tone: 'error',
          keepOnEdit: true,
        })
        return
      }
      ctx.store.commitProgram('Move tasks into the organizer', { source: split.source, controller: split.controller })
    },
  }
}

/** The organizer column. */
export function PanelOrganizer({ ctx }: { ctx: PlcPanelCtx }): ReactElement {
  const devices = useOrganizerDevices(ctx)
  return (
    <Suspense fallback={null}>
      <PlcOrganizer
        blocks={[...ctx.blocks]}
        facts={ctx.facts}
        getSource={ctx.currentSource}
        controller={ctx.table.shown}
        ownConfiguration={ctx.table.ownConfiguration}
        problems={[...ctx.table.problems]}
        activeBlock={ctx.activeBlock}
        onLadder={ctx.face === 'ladder'}
        readOnly={ctx.readOnly}
        readOnlyNote={ctx.readOnlyNote}
        revealTasks={ctx.revealTasks}
        plcs={{
          defaultName: ctx.state.externalPlc.mainName,
          defaultSimulated: !(ctx.state.externalPlc.enabled && (ctx.controller?.externalPlcAvailable ?? false)),
          named: ctx.state.externalPlc.controllers.map((c) => ({ name: c.name, simulated: c.runsOn === 'app' })),
        }}
        onPicked={ctx.onPicked}
        devices={devices}
        actions={organizerActions(ctx)}
        monitoring={{ picked: ctx.monitored, pick: ctx.pickInstance }}
      />
    </Suspense>
  )
}

/** A PROGRAM no task runs is not what is running, so nothing in it is drawn live (LadderView `idle`). */
function idleOf(ctx: PlcPanelCtx): { programs: ReadonlySet<string>; running: string } | null {
  const idle = ctx.blocks.filter((b) => b.kind === 'programPou' && b.name !== '' && !(ctx.state.controller?.programs ?? []).some((p) => (p.type ?? '').toUpperCase() === b.name.toUpperCase()))
  if (!ctx.state.controller || idle.length === 0) return null
  return {
    programs: new Set(idle.map((b) => b.name.toUpperCase())),
    running: ctx.state.controller.programs.map((p) => p.type ?? 'the top-level code').join(', ') || 'nothing',
  }
}

/** A declaration renamed (F2 in the text, or a declaration pane): its own spellings and the scene's wiring, in one
 *  commit (controllerCommit.commitTagRename). The refusal, or null when it was done.
 *  plc/tags.ts is loaded on the first rename rather than with the panel: a static import here is its only route into
 *  the first frame (~10 KB raw, scripts/lib/eager-js.mjs), and the ladder, which renames from its variable tables, has
 *  already loaded it by then. */
export async function renameDeclaration(ctx: PlcPanelCtx, scope: TagScope, from: string, to: string): Promise<string | null> {
  const { renameTag, tagNameError, tagRenamesForScene } = await import('../../../plc/tags')
  const source = ctx.currentSource()
  // the new name answers to the same rules a DECLARED one does - not a keyword, not a POU's name, not one already
  // in this scope - so renaming and declaring cannot disagree about what a name may be
  const bad = tagNameError(source, scope, to)
  if (bad !== null) return bad
  const edit = renameTag(source, scope, from, to)
  if (edit.error !== null) return edit.error
  const s = ctx.store.getState()
  const renames = tagRenamesForScene(source, scope, from, to, controllerFor(source, s.controller, s.stScanMs))
  const receipt = commitTagRename(ctx.store, edit.source, renames, `Rename ${from} to ${to}`)
  if (receipt) ctx.showReport(receipt) // what the scene's parts were rewired to, when any were
  return null
}

/** The Ladder face. */
export function PanelLadder({ ctx }: { ctx: PlcPanelCtx }): ReactElement {
  return (
    <Suspense fallback={null}>
      <LadderView
        source={ctx.ladderSource}
        onEdit={ctx.applyLadderEdit}
        onUndo={ctx.undo}
        onRedo={ctx.redo}
        getDiagnostics={(src) => {
          const s = ctx.store.getState()
          return checkFor({ source: src, controller: s.controller, scanMs: s.stScanMs, defaultName: s.externalPlc.mainName }).then((d) => d.source)
        }}
        faults={ctx.faults.marks}
        revealProblem={ctx.faults.reveal}
        getWatch={ctx.watch}
        getForces={ctx.forces}
        onForcesChange={ctx.onForces}
        live={ctx.live}
        readOnly={ctx.readOnly}
        getTags={ctx.tags}
        getDevices={() => deviceTags(ctx.store.getState().scene.parts)}
        revealRoutine={ctx.revealRoutine}
        onRevealedRoutine={ctx.onRevealedRoutine}
        idle={idleOf(ctx)}
        onShowText={ctx.showText}
        onRenameTag={ctx.readOnly ? undefined : (scope, from, to) => renameDeclaration(ctx, scope, from, to)}
        toggleBit={ctx.toggleBit}
        writeLive={ctx.writeLive}
        onWatch={ctx.addToWatch}
        onForce={ctx.force}
        onRelease={ctx.releaseForce}
      />
    </Suspense>
  )
}
