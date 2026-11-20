import { useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import type { Controller } from '../../../core/controller'
import { resolveKeyAction } from '../../../core/keymap'
import type { StBlock, TagRename } from '../../../plc'
import { taskTree } from '../../../plc/taskTree'
import { commandDisabledReason, commandEnabled, getCommand, runCommand } from '../../commands'
import { keyHint } from '../../keyHint'
import { organizerGroups, type OrganizerFacts, type OrganizerRow } from '../../program/plcOrganizer'
import { ProgramPropertiesDialog, TaskPropertiesDialog } from './ControllerPropertiesDialogs'
import type { MenuItem } from '../inspector/menu'
import { OrganizerTree, type OrganizerContent, type OrganizerDevices, type TreeCtx } from './OrganizerTree'
import { FoldIcon } from '../toolbarIcons'
import { defineMessages, t, type MessageId } from '../../../core/i18n'

const M = defineMessages('plcOrganizer', {
  newStProgram: 'Structured Text program',
  newStProgramHint: 'A PROGRAM written in Structured Text: its body is statements, and it opens in the code editor. Run by an instance on the first task',
  newLadderProgram: 'Ladder program',
  newLadderProgramHint: 'A PROGRAM written as ladder: its body is rungs, and it opens on the ladder sheet. Run by an instance on the first task',
  newFunctionBlock: 'Function block',
  newFunctionBlockHint: 'A reusable POU with state of its own, instantiated in a program (FUNCTION_BLOCK), written in Structured Text',
  newFunction: 'Function',
  newFunctionHint: 'A stateless POU that returns a value (FUNCTION), written in Structured Text',
  newDataTypes: 'Data types',
  newDataTypesHint: 'A TYPE ... END_TYPE block: structs, enumerations and subranges',
  newGlobals: 'Global variables',
  newGlobalsHint: 'A VAR_GLOBAL ... END_VAR block, in scope for every POU',
  langLadder: 'ladder',
  langSt: 'Structured Text',
  langStAndLadder: 'Structured Text and ladder',
  topLevel: 'top-level code',
  topLevelRow: 'Top-level code',
  wordProgram: 'the top-level code',
  wordProgramPou: 'program',
  wordConfiguration: 'configuration',
  wordFunctionBlock: 'function block',
  wordFunction: 'function',
  wordType: 'type declarations',
  wordGlobal: 'global variables',
  titleProgram: 'The top-level code',
  titleProgramPou: 'Program',
  titleConfiguration: 'Configuration',
  titleFunctionBlock: 'Function block',
  titleFunction: 'Function',
  titleType: 'Type declarations',
  titleGlobal: 'Global variables',
  open: 'Open',
  showAsText: 'Show as text',
  showAsTextHint: 'The rungs as the text they are saved as. Open the program again for the rungs',
  rename: 'Rename',
  delete: 'Delete',
  deleteHintKey: 'Deletes it and the comment written above it ({key}). {undo} undoes it',
  deleteHint: 'Deletes it and the comment written above it. {undo} undoes it',
  undo: 'Undo',
  newNameFor: 'New name for {kind} {name}',
  shownBadge: 'live',
  shownHint: "The live values in {type}'s code are {instance}'s. Click another {type} instance to show its values.",
  topBodyRuns: 'The top-level code and variables: the code outside every POU, and the statements its Main instance runs',
  topVariables: 'The top-level variables: the code outside every POU, which the scene is wired to by name',
  blockTitleNamed: '{kind} {name}',
  blockIdle: '{title}. No task runs it',
  blockLadder: '{title}. It is ladder, so it opens as rungs',
  blockStLd: '{title}. It is Structured Text with a ladder section in it',
  blockIdleLadder: '{title}. It is ladder, so it opens as rungs. No task runs it',
  blockIdleStLd: '{title}. It is Structured Text with a ladder section in it. No task runs it',
  newMenuTitle: 'Add a program, function block, function, data types or global variables',
  ownConfiguration: 'The tasks come from the CONFIGURATION in the code.',
  adoptHint: 'Move its tasks and programs into the organizer, where they are edited here',
  adopt: 'Edit them here',
  taskNewSt: 'New Structured Text program',
  taskNewStHint: 'A new PROGRAM written in Structured Text, run by this task',
  taskNewLadder: 'New ladder program',
  taskNewLadderHint: 'A new PROGRAM written as ladder, run by this task: it opens on the ladder sheet',
  pinned: 'It runs the statements outside every PROGRAM. Move them into a PROGRAM first',
  groupPrograms: 'Programs',
  addProgram: 'Add a program',
  groupFunctionBlocks: 'Function Blocks',
  addFunctionBlock: 'Add a function block',
  groupFunctions: 'Functions',
  addFunction: 'Add a function',
  groupDataTypes: 'Data Types',
  addDataTypes: 'Add a block of type declarations',
  groupGlobals: 'Global Variables',
  addGlobals: 'Add a block of global variables',
})

// The organizer's rows from the program text, hung in the tree (OrganizerTree.tsx): under the Controller node the code
// outside every POU (Top-level code: the top-level variables, and its statements when it has any), and below the Tasks the POUs
// by kind, the data types and the global variables, each a block of the program text (plcOrganizer.ts). The tree draws
// the Tasks and the scene's Devices itself. A delete is not asked about: undo takes it back.
//
// It replaced two things that each showed half of the program: a row of POU chips over the code, which scrolled
// sideways once a program had more POUs than fit, and the Controller dock's task tables, which were a tab in the same
// dock strip as the code and so could never be on screen beside it.

export type ProgramKind = 'programPou' | 'ladderProgram'
export type DeclKind = 'functionBlock' | 'function' | 'type' | 'global'

export interface OrganizerActions {
  /** open block `index` in its own face: a ladder POU as rungs, anything else as text */
  open: (index: number) => void
  /** a ladder POU's rung text */
  showAsText: (index: number) => void
  /** add a block of `kind`; where it landed and its name when it has one to ask for, else null */
  addBlock: (kind: DeclKind) => { index: number; name: string } | null
  /** the name a new PROGRAM would take, or null when the program cannot take one (the panel says why) */
  suggestProgram: (kind: ProgramKind) => string | null
  /** add PROGRAM `name` and run it on `task` (the first task when absent) as one edit; why the name was refused, or null */
  addProgram: (name: string, kind: ProgramKind, task?: string) => string | null
  blockNameError: (index: number, name: string) => string | null
  renameBlock: (index: number, name: string) => void
  deleteBlock: (index: number) => void
  /** a controller table edit, with the tags it renames */
  editController: (next: Controller, renames: TagRename[], label: string) => void
  /** move the tasks of the code's own CONFIGURATION into the table */
  adoptConfiguration: () => void
  /** download one controller's program (null: the default one) */
  exportController?: (plc: string | null, target: 'iec-text' | 'plcopen-xml') => void
}

export interface PlcOrganizerProps {
  blocks: StBlock[]
  facts: OrganizerFacts
  /** the program text now, for what a rename in Program Properties moves */
  getSource: () => string
  /** the table the program runs from: the scene's own, or the default one a program with none runs from */
  controller: Controller
  /** the program declares its own CONFIGURATION, so its tasks are text, not table rows */
  ownConfiguration: boolean
  /** the table's own problems (plc controllerDiagnostics), shown under Tasks */
  problems: readonly string[]
  /** the block the reader is in */
  activeBlock: number
  /** the panel shows rungs (so a ladder POU's "Show as text" means something) */
  onLadder: boolean
  readOnly: boolean
  readOnlyNote: string
  /** bumped to bring the Tasks section into view, unfolded (Problems and the panel's "Open tasks" links) */
  revealTasks: number
  /** drawn over the code in a narrow panel: a pick closes it */
  onPicked?: () => void
  /** the scene's controllers, which a program instance can be run on (Program Properties) */
  plcs?: { defaultName: string; defaultSimulated: boolean; named: readonly { name: string; simulated: boolean }[] }
  /** the scene's parts that speak tags, for the tree's Devices section (components/plc/plcDevices.ts) */
  devices: OrganizerDevices
  actions: OrganizerActions
  /** the instance whose live values the code shows for a PROGRAM that runs as several (by type upper-cased; else the
   *  first), and picking one */
  monitoring?: { picked: Readonly<Record<string, string>>; pick: (type: string, instance: string) => void }
}

/** What "+" at the top offers, in the tree's own words. A program is made in a language, and every surface that makes
 *  one names it (the menus here, the badge on the name field), so "Program" never silently means Structured Text. */
const NEW_KINDS: { kind: ProgramKind | DeclKind; label: MessageId; hint: MessageId }[] = [
  { kind: 'programPou', label: M.newStProgram, hint: M.newStProgramHint },
  { kind: 'ladderProgram', label: M.newLadderProgram, hint: M.newLadderProgramHint },
  { kind: 'functionBlock', label: M.newFunctionBlock, hint: M.newFunctionBlockHint },
  { kind: 'function', label: M.newFunction, hint: M.newFunctionHint },
  { kind: 'type', label: M.newDataTypes, hint: M.newDataTypesHint },
  { kind: 'global', label: M.newGlobals, hint: M.newGlobalsHint },
]

const isProgramKind = (k: string): k is ProgramKind => k === 'programPou' || k === 'ladderProgram'

/** The language of a program being added, for the badge on its name field: the same words the rows' badges use. */
const programLanguage = (k: string): { tag: string; name: string; ladder: boolean } =>
  k === 'ladderProgram' ? { tag: 'LD', name: t(M.langLadder), ladder: true } : { tag: 'ST', name: t(M.langSt), ladder: false }

/** A block's kind in a sentence ("New name for function block Merge"), and as a tooltip's first word. Message ids. */
const KIND_WORD: Record<StBlock['kind'], MessageId> = {
  program: M.wordProgram,
  programPou: M.wordProgramPou,
  configuration: M.wordConfiguration,
  functionBlock: M.wordFunctionBlock,
  function: M.wordFunction,
  type: M.wordType,
  global: M.wordGlobal,
}
const KIND_TITLE: Record<StBlock['kind'], MessageId> = {
  program: M.titleProgram,
  programPou: M.titleProgramPou,
  configuration: M.titleConfiguration,
  functionBlock: M.titleFunctionBlock,
  function: M.titleFunction,
  type: M.titleType,
  global: M.titleGlobal,
}

/** A block row's tooltip: its title, then whether it is ladder and whether a task runs it, as one message each. */
function blockTitle(title: string, idle: boolean | undefined, language: 'ladder' | 'stld' | null): string {
  if (language === 'ladder') return t(idle ? M.blockIdleLadder : M.blockLadder, { title })
  if (language === 'stld') return t(idle ? M.blockIdleStLd : M.blockStLd, { title })
  return idle ? t(M.blockIdle, { title }) : title
}

/** A block's Delete tooltip, with the keymap's Delete and Undo chords. */
function deleteHint(): string {
  const key = keyHint('edit.delete')
  const undo = keyHint('edit.undo') ?? t(M.undo)
  return key ? t(M.deleteHintKey, { key, undo }) : t(M.deleteHint, { undo })
}

export function PlcOrganizer(props: PlcOrganizerProps): ReactElement {
  const { blocks, facts, controller, ownConfiguration, problems, activeBlock, onLadder, readOnly, readOnlyNote, revealTasks, onPicked, devices, actions, monitoring } = props
  const groups = useMemo(() => organizerGroups(blocks, facts), [blocks, facts])
  const types = useMemo(() => groups.programs.map((r) => r.name), [groups])
  const plcs = props.plcs
  const tree = useMemo(() => taskTree(types, controller, facts.bodyRuns, plcs && { defaultName: plcs.defaultName, named: plcs.named.map((c) => c.name) }), [types, controller, facts.bodyRuns, plcs])
  // a name field outlives the render that opened it (an added block is named once it is in the blocks): its commit reads these
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks

  /** The instances running a PROGRAM type, in run order. */
  const instancesOf = (type: string): string[] => controller.programs.filter((q) => q.type?.toUpperCase() === type.toUpperCase()).map((q) => q.name)
  /** The instance whose values the code shows for its type: the one picked while it still runs, else the first. */
  const shownOf = (type: string): string | undefined => {
    const names = instancesOf(type)
    const pick = monitoring?.picked[type.toUpperCase()]
    return names.find((n) => pick !== undefined && n.toUpperCase() === pick.toUpperCase()) ?? names[0]
  }

  /** The block a program instance runs: its PROGRAM, or the code outside every PROGRAM. */
  const blockOfProgram = (type: string | null): number =>
    type === null ? (groups.top?.index ?? -1) : (groups.programs.find((r) => r.name.toUpperCase() === type.toUpperCase())?.index ?? -1)

  /** A command as a menu item: its own label, and greyed out with its own reason where it is disabled (commands.ts). */
  const commandItem = (id: string, testid: string): MenuItem => {
    const on = commandEnabled(id)
    return { label: getCommand(id)?.label ?? id, testid, disabled: !on, title: on ? undefined : (commandDisabledReason(id) ?? undefined), onClick: () => runCommand(id) }
  }
  /** Giving the top-level variables their I/O addresses: the project's business, so the program's, not the link's. */
  const ioItems = (): MenuItem[] => [
    { label: '-', onClick: () => {} },
    commandItem('sim.assignIo', 'org-assign-io'),
    commandItem('file.importIoList', 'org-import-io'),
    commandItem('file.exportIoList', 'org-export-io'),
  ]

  const renameKey = (index: number): string => `block:${index}`

  /** A POU, a TYPE block or a VAR_GLOBAL block. */
  const blockRow = (row: OrganizerRow, ctx: TreeCtx): ReactElement => {
    const isActive = row.index === activeBlock
    const nameable = row.name !== ''
    const ladder = row.language === 'LD'
    const deletable = row.kind !== 'program' && row.kind !== 'configuration'
    const open = (): void => {
      actions.open(row.index)
      ctx.picked()
    }
    const beginRename = (): void => {
      if (readOnly || !nameable) return
      ctx.rename.begin(renameKey(row.index), row.name, (to) => {
        if (to.trim() === (blocksRef.current[row.index]?.name ?? '')) return null
        const why = actions.blockNameError(row.index, to)
        if (why === null) actions.renameBlock(row.index, to)
        return why
      })
    }
    const items: MenuItem[] = [
      { label: t(M.open), onClick: open },
      ...(row.kind === 'program' ? ioItems() : []),
      ...(ladder && onLadder ? [{ label: t(M.showAsText), testid: 'org-show-text', title: t(M.showAsTextHint), onClick: () => { actions.showAsText(row.index); ctx.picked() } }] : []),
      ...(!readOnly && (nameable || deletable) ? [{ label: '-', onClick: () => {} }] : []),
      ...(!readOnly && nameable ? [{ label: t(M.rename), testid: 'org-rename-item', title: keyHint('edit.rename') ?? undefined, onClick: beginRename }] : []),
      ...(!readOnly && deletable
        ? [{ label: t(M.delete), testid: 'org-delete-item', title: deleteHint(), onClick: () => actions.deleteBlock(row.index) }]
        : []),
    ]
    if (ctx.rename.active(renameKey(row.index))) {
      return (
        <div key={`rename-${row.index}`} className="org-row org-edit-row" data-block-index={row.index}>
          {ctx.rename.field(renameKey(row.index), { testid: 'org-rename', label: t(M.newNameFor, { kind: t(KIND_WORD[row.kind]), name: row.name }) })}
        </div>
      )
    }
    const kindTitle = t(KIND_TITLE[row.kind])
    const title =
      row.kind === 'program'
        ? facts.bodyRuns
          ? t(M.topBodyRuns)
          : t(M.topVariables)
        : blockTitle(row.name ? t(M.blockTitleNamed, { kind: kindTitle, name: row.name }) : kindTitle, row.unscheduled, ladder ? 'ladder' : row.language === 'ST+LD' ? 'stld' : null)
    return (
      <div
        key={`${row.kind}:${row.name}:${row.index}`}
        className={`org-row org-block${isActive ? ' active' : ''}${row.unscheduled ? ' idle' : ''}`}
        role="treeitem"
        tabIndex={0}
        data-testid={row.kind === 'program' ? 'org-top' : 'org-pou'}
        data-block-index={row.index}
        data-kind={row.kind}
        data-lang={row.language ?? undefined}
        data-unscheduled={row.unscheduled || undefined}
        aria-current={isActive ? 'location' : undefined}
        title={title}
        onClick={open}
        onDoubleClick={beginRename}
        onContextMenu={(e) => ctx.openMenu(e, items)}
        onKeyDown={(e: ReactKeyboardEvent) => {
          // the keymap's rename and delete (keymap.ts edit.rename / edit.delete), as the scene tree reads them; Enter is
          // a tree row's own activation
          const action = resolveKeyAction(e, 'editor')
          if (e.key === 'Enter') open()
          else if (action === 'edit.rename' && nameable && !readOnly) beginRename()
          else if (action === 'edit.delete' && deletable && !readOnly) actions.deleteBlock(row.index)
          else return
          e.preventDefault()
          // the app's own keydown listens on the window: a Delete that reached it would delete the selected part too
          e.stopPropagation()
        }}
      >
        {/* the code outside every POU is named Main in the program, but its instance on a task is also Main, and two
            rows reading Main read as one listed twice */}
        <span className="org-name">{row.kind === 'program' ? t(M.topLevelRow) : row.label}</span>
        {row.language && row.kind !== 'program' && (
          <span className={`org-lang${ladder ? ' ld' : ''}`} aria-label={t(ladder ? M.langLadder : row.language === 'ST' ? M.langSt : M.langStAndLadder)}>
            {row.language}
          </span>
        )}
      </div>
    )
  }

  const add = (kind: ProgramKind | DeclKind, ctx: TreeCtx): void => {
    if (isProgramKind(kind)) return ctx.addProgram(kind)
    ctx.setNote(null)
    const added = actions.addBlock(kind)
    if (added !== null) {
      ctx.rename.begin(renameKey(added.index), added.name, (to) => {
        if (to.trim() === (blocksRef.current[added.index]?.name ?? added.name)) return null
        const why = actions.blockNameError(added.index, to)
        if (why === null) actions.renameBlock(added.index, to)
        return why
      })
    }
  }

  /** A group of blocks of one kind. Not drawn while empty, unless a new one is being named in it. */
  const blockGroup = (ctx: TreeCtx, key: string, titleId: MessageId, rows: OrganizerRow[], newKind: ProgramKind | DeclKind, newTitleId: MessageId, extra?: ReactNode): ReactElement | null => {
    if (rows.length === 0 && !extra) return null
    const title = t(titleId)
    const newTitle = t(newTitleId)
    const closed = ctx.isFolded(key)
    return (
      <div className="org-section" data-testid="org-group" data-group={key} role="group" aria-label={title}>
        <div className="org-head top" role="button" tabIndex={0} aria-expanded={!closed} onClick={() => ctx.toggle(key)} onKeyDown={(e) => e.key === 'Enter' && ctx.toggle(key)}>
          <span className="org-fold" aria-hidden="true">
            <FoldIcon closed={closed} />
          </span>
          <span className="org-title">{title}</span>
          <span className="org-count">{rows.length}</span>
          {!readOnly && (
            <button
              type="button"
              className="org-btn"
              data-testid={`org-add-${key}`}
              title={newTitle}
              aria-label={newTitle}
              onClick={(e) => {
                e.stopPropagation()
                if (newKind === 'programPou') ctx.menuBelow(e, NEW_KINDS.filter((k) => isProgramKind(k.kind)).map((k) => ({ label: t(k.label), title: t(k.hint), testid: `org-new-${k.kind}`, onClick: () => add(k.kind, ctx) })))
                else add(newKind, ctx)
              }}
            >
              +
            </button>
          )}
        </div>
        {!closed && (
          <div className="org-children" role="group">
            {rows.map((r) => blockRow(r, ctx))}
            {extra}
          </div>
        )}
      </div>
    )
  }

  const content: OrganizerContent = {
    newMenu: (ctx) => ({
      title: t(M.newMenuTitle),
      // the two programs first, apart from the declarations: the language is the choice being made there
      items: NEW_KINDS.flatMap((k, i) => [
        ...(i > 0 && isProgramKind(NEW_KINDS[i - 1]!.kind) && !isProgramKind(k.kind) ? [{ label: '-', onClick: () => {} }] : []),
        { label: t(k.label), title: t(k.hint), testid: `org-new-${k.kind}`, onClick: () => add(k.kind, ctx) },
      ]),
    }),
    controllerMenu: ioItems,
    controllerChildren: (ctx) => groups.top && <div className="org-children org-top">{blockRow(groups.top, ctx)}</div>,
    ownConfiguration: (ctx) => (
      <div className="org-empty" data-testid="org-own-configuration">
        {t(M.ownConfiguration)}
        {!readOnly && (
          <button type="button" className="org-btn org-inline-btn" data-testid="org-adopt" title={t(M.adoptHint)} onClick={actions.adoptConfiguration}>
            {t(M.adopt)}
          </button>
        )}
        {groups.configuration && blockRow(groups.configuration, ctx)}
      </div>
    ),
    taskMenu: (task, parts, ctx) => [
      { label: t(M.taskNewSt), testid: 'org-task-new-program', disabled: ctx.tableLocked, title: ctx.tableTitle(t(M.taskNewStHint)), onClick: () => ctx.addProgram('programPou', task.name) },
      { label: t(M.taskNewLadder), testid: 'org-task-new-ladder-program', disabled: ctx.tableLocked, title: ctx.tableTitle(t(M.taskNewLadderHint)), onClick: () => ctx.addProgram('ladderProgram', task.name) },
      { label: '-', onClick: () => {} },
      parts.properties,
      parts.delete,
    ],
    suggestProgram: (kind) => actions.suggestProgram(isProgramKind(kind) ? kind : 'programPou'),
    addProgram: (name, kind, task) => actions.addProgram(name, isProgramKind(kind) ? kind : 'programPou', task),
    draftLanguage: programLanguage,
    program: {
      label: (p) => (p.index < 0 ? (p.type ?? t(M.topLevel)) : p.name),
      kind: (p) => (p.index < 0 ? null : p.type === null ? t(M.topLevel) : p.type !== p.name ? `: ${p.type}` : null),
      block: (p) => blockOfProgram(p.type),
      open: actions.open,
      menu: (_p, parts, scheduled) => (scheduled ? [parts.showCode, parts.properties, { label: '-', onClick: () => {} }, parts.runEarlier, parts.runLater, parts.stopRunning] : [parts.showCode, parts.schedule]),
      pinned: (p) => (p.type === null && facts.bodyRuns ? t(M.pinned) : null),
      monitor: (p) => {
        if (p.type !== null && instancesOf(p.type).length > 1) monitoring?.pick(p.type, p.name)
      },
      shown: (p) =>
        p.type !== null && instancesOf(p.type).length > 1 && shownOf(p.type) === p.name ? { label: t(M.shownBadge), title: t(M.shownHint, { type: p.type, instance: p.name }) } : null,
    },
    // PROGRAMs no instance runs, and the top-level statements when no instance runs them
    unscheduled: (tree) => [...(tree.topLevelUnrun ? [null] : []), ...tree.unscheduled],
    groups: (ctx) => (
      <>
        {blockGroup(ctx, 'programs', M.groupPrograms, groups.programs, 'programPou', M.addProgram, ctx.draftField(undefined))}
        {blockGroup(ctx, 'functionBlocks', M.groupFunctionBlocks, groups.functionBlocks, 'functionBlock', M.addFunctionBlock)}
        {blockGroup(ctx, 'functions', M.groupFunctions, groups.functions, 'function', M.addFunction)}
        {blockGroup(ctx, 'dataTypes', M.groupDataTypes, groups.dataTypes, 'type', M.addDataTypes)}
        {blockGroup(ctx, 'globals', M.groupGlobals, groups.globals, 'global', M.addGlobals)}
      </>
    ),
    taskDialog: (index, close, ctx) => (
      <TaskPropertiesDialog types={types} topLevelStatements={facts.bodyRuns} controller={controller} {...(props.plcs ? { plcs: props.plcs } : {})} index={index} readOnly={ctx.tableLocked ? ctx.tableTitle('') : null} onCommit={ctx.editTable} onClose={close} />
    ),
    programDialog: (index, close, ctx) => (
      <ProgramPropertiesDialog
        topLevelStatements={facts.bodyRuns}
        source={props.getSource()}
        controller={controller}
        types={types}
        {...(props.plcs ? { plcs: props.plcs } : {})}
        index={index}
        readOnly={ctx.tableLocked ? ctx.tableTitle('') : null}
        onCommit={ctx.editTable}
        onClose={close}
      />
    ),
  }

  return (
    <OrganizerTree
      content={content}
      controller={controller}
      tree={tree}
      ownConfiguration={ownConfiguration}
      problems={problems}
      readOnly={readOnly}
      readOnlyNote={readOnlyNote}
      revealTasks={revealTasks}
      activeBlock={activeBlock}
      onPicked={onPicked}
      devices={devices}
      {...(props.plcs ? { plcs: props.plcs } : {})}
      onControllerProperties={() => runCommand('sim.externalPlc')}
      editController={actions.editController}
      {...(actions.exportController ? { onExportController: actions.exportController } : {})}
    />
  )
}
