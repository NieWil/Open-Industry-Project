import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ownSharedProject } from '../project/sharedProject'
import { currentDocumentId, documentsOpenInTabs, listDocuments, supportsDocumentLibrary } from '../project/documentStore'
import { getOipProjectApi } from '../desktop/desktopProjectApi'
import { openDocumentInNewWindow, openStoredDocument } from '../desktop/desktopProjectBridge'
import { commandChord, commandDisabledReason, commandEnabled, getCommand, runCommand } from '../commands'
import { DEMO_SCENE_NAME } from '../demo/demoScenes'
import { DESKTOP_SHELL } from '../desktop/desktopMenuBridge'
import { withKey } from '../keyHint'
import type { EditorState, EditorStore } from '../store/store'
import { focusFirstMenuItem, fromKeyboard, menuKeys, useDismiss } from './popover'
import { ChevronIcon } from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('projectMenu', {
  hintImport:
    'Open a project file ({oip}), or a scene file ({json}) from an earlier version, as a project of its own. This one is kept in your projects',
  hintExport: 'Download the project as one file: to keep a copy, or to send a job (you can leave out what the scene does not use)',
  hintDemo: 'Open the built-in example. Edit it and it becomes a project of your own',
  saveToFolder: 'Save the project to its folder now',
  save: 'Save the project',
  saveAlsoAuto: '{save}. It also saves itself as you go',
  stopFirst: 'Stop the simulation first',
  example: 'Example',
  exampleTitle: '{project}, the built-in example: edit it and it becomes a project of your own; open another project to leave it',
  projectTitle: 'Project “{project}”',
  menu: 'Project',
  recentHead: 'Recent projects',
  openRecent: 'Open “{name}”',
  openRecentFolder: 'Open “{name}” from {folder}',
  recentElsewhere: '“{name}” is open in another window. Bring it forward',
})

// The project menu: the top bar's one document control, for the project on screen (or the built-in example)
// and everything you do to it. Project actions (New / Save / Demo, Export / Import Project) live here rather
// than as loose buttons in the row, where they would sit beside scene-level controls with nothing to tell
// them apart. There is no scene switcher: a project holds one scene (format 4, core/project/project.ts). The demo is
// a project of its own (the built-in example): while it is open the label reads "Palletizing demo" with an
// Example badge, and leaving it means opening another project.
//
// Every action row is a command (editor/commands.ts): label, chord and enablement are the registry's, so this,
// the desktop File menu and the palette cannot drift apart. The one exception is the "Recent projects" block
// after the project's own rows: the few changed last, one click from open. They are data, so they are not commands.

/** projects split off an older multi-scene project, waiting to be downloaded (shown only while some wait) */
const SPLIT_OFF_ROWS: readonly string[] = ['file.exportSplitOff']

/** the menu's first block: Save is the row people reach for without reading */
const SAVE_ROWS: readonly string[] = ['file.save', 'file.saveProject', 'file.copyRoom']

/** the project block, top to bottom; null is a separator */
const PROJECT_ROWS: readonly (string | null)[] = [
  'file.newProject',
  'file.projects',
  'file.renameProject',
  null,
  'file.importProject',
  'file.exportProject',
  null,
  'file.openDemo',
]

const HINTS: Record<string, MessageId> = {
  'file.importProject': M.hintImport,
  'file.exportProject': M.hintExport,
  // the tooltip is the only place to say that opening the example adds nothing until it is edited
  'file.openDemo': M.hintDemo,
}
// i18n-ok: file extensions
const HINT_PARAMS = { oip: '.oip', json: '.json' }

// Save is the project save (editor/project/saveProject.ts). Its hint names a chord, so it is built at render from
// the active keymap rather than typed in (keyHint.ts).
const saveHint = (): string =>
  DESKTOP_SHELL
    ? withKey(t(M.saveToFolder), 'file.save')
    : t(M.saveAlsoAuto, { save: withKey(t(M.save), 'file.save') })

/**
 * A row's tooltip: why it is greyed while it is, otherwise what it does. A disabled control that keeps
 * advertising what it would do reads as broken. Running is the global block every file action shares
 * (commands.ts `editable`), so it is said here once rather than by each command.
 */
function rowTitle(id: string, state: EditorState): string | undefined {
  if (!commandEnabled(id)) {
    const why = commandDisabledReason(id) ?? (state.running ? t(M.stopFirst) : null)
    if (why) return why
  }
  if (id === 'file.save') return saveHint()
  const hint = HINTS[id]
  return hint === undefined ? undefined : t(hint, HINT_PARAMS)
}

/** the shell's and the browser's own commands only, Copy Room only in a room; no separator first, last or twice */
function visibleRows(ids: readonly (string | null)[], state: EditorState): (string | null)[] {
  const kept = ids.filter((id) => {
    if (id === null) return true
    const cmd = getCommand(id)
    if (!cmd || (DESKTOP_SHELL ? cmd.webOnly : cmd.shellOnly)) return false
    if (id === 'file.copyRoom') return state.collab
    // inside the example it would reopen what is already open: an untouched example (editing forks it into a
    // project) rebuilt from the same source, which reads as a row that does nothing. The palette keeps it.
    if (id === 'file.openDemo') return !state.demoSession
    // shown only while there is something to download (projectSplit.ts)
    if (id === 'file.exportSplitOff') return commandEnabled(id)
    return true
  })
  return kept.filter((id, i) => id !== null || (i > 0 && i < kept.length - 1 && kept[i - 1] !== null))
}

/** how many other projects the menu lists; the projects list has them all */
const RECENT_COUNT = 4

interface RecentProject {
  id: string
  name: string
  /** its folder on the desktop; null in the browser, and for a project stored in the app only */
  folder: string | null
  /** another window has it open (desktop), so the row brings that window forward */
  elsewhere: boolean
}

/**
 * The projects changed most recently, without the one on screen. In the example the working copy still holds the
 * user's own project, which is not on screen, so it is listed (ProjectsOverlay `onScreen`).
 */
async function readRecentProjects(demoSession: boolean): Promise<RecentProject[]> {
  if (!supportsDocumentLibrary()) return []
  const api = getOipProjectApi()
  const [docs, folders, inTabs] = await Promise.all([listDocuments(), api ? api.folders() : [], api ? documentsOpenInTabs() : null])
  const openId = currentDocumentId()
  return docs
    .filter((doc) => doc.id !== openId || demoSession)
    .slice(0, RECENT_COUNT)
    .map((doc) => ({
      id: doc.id,
      name: doc.name,
      folder: folders.find((f) => f.docId === doc.id)?.path ?? null,
      elsewhere: doc.id !== openId && (inTabs?.has(doc.id) ?? false),
    }))
}

/** Open a recent row as the projects list opens its row. The menu has closed by then, so a failure is an alert. */
function openRecentProject(store: EditorStore, row: RecentProject): void {
  const opened = row.elsewhere ? openDocumentInNewWindow(row.id, row.folder) : openStoredDocument(store, row.id, row.folder)
  void opened
    .then((error) => error !== null && alert(error))
    .catch((e: unknown) => alert(e instanceof Error ? e.message : String(e)))
}

function RecentRows({ rows, store, onPick }: { rows: readonly RecentProject[]; store: EditorStore; onPick: () => void }) {
  if (rows.length === 0) return null
  return (
    <>
      {/* a block of its own with a heading: a bare project name among the actions does not say what a click does */}
      <div className="help-sep" role="separator" />
      <div className="project-recent-head" role="presentation">
        {t(M.recentHead)}
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          className="help-item project-recent"
          role="menuitem"
          data-recent-project={row.id}
          title={
            row.elsewhere
              ? t(M.recentElsewhere, { name: row.name })
              : row.folder !== null
                ? t(M.openRecentFolder, { name: row.name, folder: row.folder })
                : t(M.openRecent, { name: row.name })
          }
          onClick={() => {
            onPick()
            openRecentProject(store, row)
          }}
        >
          <span className="help-item-label">{row.name}</span>
        </button>
      ))}
    </>
  )
}

function CommandRows({
  ids,
  state,
  onPick,
  after,
}: {
  ids: readonly (string | null)[]
  state: EditorState
  onPick: () => void
  /** rows that are not commands, shown after the command with this id; they bring their own leading separator */
  after?: { id: string; rows: ReactNode }
}) {
  return (
    <>
      {visibleRows(ids, state).map((id, i) => {
        if (id === null) return <div key={`sep-${i}`} className="help-sep" role="separator" />
        const cmd = getCommand(id)!
        const chord = commandChord(cmd)
        const row = (
          <button
            key={id}
            className="help-item"
            role="menuitem"
            data-command={id}
            disabled={!commandEnabled(id)}
            title={rowTitle(id, state)}
            onClick={() => {
              onPick()
              runCommand(id)
            }}
          >
            <span className="help-item-label">{cmd.label}</span>
            {chord && <kbd className="help-item-key">{chord}</kbd>}
          </button>
        )
        return after?.id === id ? [row, <Fragment key={`after-${id}`}>{after.rows}</Fragment>] : row
      })}
    </>
  )
}

export function ProjectMenu({ store, state }: { store: EditorStore; state: EditorState }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const byKey = useRef(false)
  const close = () => setOpen(false)
  useDismiss(wrapRef, close, { active: open, trigger: buttonRef })
  useEffect(() => {
    if (open && byKey.current) focusFirstMenuItem(listRef.current)
  }, [open])

  // The other projects, read each time the menu opens. The last answer stays between opens, so on every open
  // after the first the rows are there from the first frame and the rows under them do not move.
  const [recent, setRecent] = useState<readonly RecentProject[]>([])
  const demoSession = state.demoSession
  useEffect(() => {
    if (!open) return
    let live = true
    void readRecentProjects(demoSession)
      .then((rows) => live && setRecent(rows))
      .catch((e: unknown) => console.warn('[oip] listing recent projects failed', e))
    return () => {
      live = false
    }
  }, [open, demoSession])

  // The demo is a project of its own, the built-in example (sceneFile.openDemoScene): it is named, and tagged as
  // the example, because nothing of it is saved until it is edited. In a room the document is the room's, and
  // `projectName` is still this browser's own local default - naming the menu with it would name the wrong thing.
  // Shared, a project is still named (project/sharedProject.ts): the owner's own name for it, and everyone else the name
  // its room carries (main.tsx bootRoom). That it is shared shows where sharing is controlled, as elsewhere.
  const own = state.collab ? ownSharedProject() : null
  const project = state.demoSession ? DEMO_SCENE_NAME : own ? own.project : state.projectName
  const tag = state.demoSession ? t(M.example) : null
  return (
    <div className="project-menu" ref={wrapRef} data-tagged={tag !== null}>
      <button
        ref={buttonRef}
        type="button"
        className={`project-button${open ? ' active' : ''}`}
        data-testid="project-menu"
        title={
          tag ? t(M.exampleTitle, { project }) : t(M.projectTitle, { project })
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          byKey.current = fromKeyboard(e)
          setOpen((v) => !v)
        }}
      >
        <span className="project-name">{project}</span>
        {/* a status badge, not a second name: "Name · Example" read as a path into something (the old
            project · scene crumb), and "Example" is what the project is, not where it is */}
        {tag !== null && (
          <span className="project-tag" data-testid="project-tag">
            {tag}
          </span>
        )}
        <ChevronIcon dir="down" size={12} />
      </button>
      {open && (
        <div className="overflow-popover project-popover" role="menu" aria-label={t(M.menu)} ref={listRef} onKeyDown={menuKeys(close)}>
          {/* one list, so a block with nothing to show (the split-off projects, usually) leaves no doubled separator */}
          <CommandRows
            ids={[...SAVE_ROWS, null, ...SPLIT_OFF_ROWS, null, ...PROJECT_ROWS]}
            state={state}
            onPick={close}
            // where the projects list is refused (a view-only link), so is opening a project from here
            after={commandEnabled('file.projects') ? { id: 'file.renameProject', rows: <RecentRows rows={recent} store={store} onPick={close} /> } : undefined}
          />
        </div>
      )}
    </div>
  )
}
