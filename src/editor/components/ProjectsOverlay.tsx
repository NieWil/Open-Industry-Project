import { useCallback, useEffect, useRef, useState } from 'react'
import { commandEnabled, runCommand } from '../commands'
import { DEMO_SCENE_NAME } from '../demo/demoScenes'
import {
  currentDocumentId,
  deleteDocument,
  documentsOpenInTabs,
  listDocuments,
  renameDocument,
  requestDurableStorage,
  supportsDocumentLibrary,
} from '../project/documentStore'
import type { DocumentMeta } from '../project/documentStore'
import { openDocumentInNewWindow, openStoredDocument } from '../desktop/desktopProjectBridge'
import { createNewProject, UNTITLED_PROJECT } from '../project/newProject'
import { getOipProjectApi } from '../desktop/desktopProjectApi'
import type { FolderRecord } from '../desktop/desktopProjectApi'
import type { EditorState, EditorStore } from '../store/store'
import { CloseIcon, PencilIcon, PeopleIcon, RestoreIcon, TrashIcon } from './toolbarIcons'
import { renameSharedProject, sharedProjectOf } from '../project/sharedProject'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('projects', {
  sharedTitle: 'Shared: people with its links edit it with you',
  confirmRemove: 'Remove “{name}” from this list? Its folder stays on disk: {folder}',
  confirmDelete: 'Delete “{name}”? This cannot be undone.',
  removeFailed: 'That project could not be removed.',
  renameFailed: 'That project could not be renamed.',
  title: 'Projects',
  close: 'Close',
  introDesktop:
    'Your projects on this computer, each with the folder it lives in. Opening one reloads the editor into it. Your current work is saved first.',
  introBrowser: 'Every project you have made in this browser. Opening one reloads the editor into it. Your current work is saved first.',
  introSingle:
    'This browser cannot store more than one project, so only the one you have open is kept. Export it as a {ext} file to keep more than one.',
  reading: 'Reading your projects…',
  empty: 'No projects stored yet.',
  projectName: 'Project name',
  alreadyOpen: 'Already open',
  openNamed: 'Open “{name}”',
  openNow: 'open now',
  storedInApp: 'Stored in the app only',
  showNamedInFolder: 'Show {name} in its folder',
  showInFolder: 'Show in folder',
  renameNamed: 'Rename {name}',
  rename: 'Rename',
  removeNamed: 'Remove {name}',
  deleteNamed: 'Delete {name}',
  openAnotherFirst: 'Open another project first',
  openInOtherTab: 'open in another tab',
  openInOtherWindow: 'open in another window',
  closeOtherTabFirst: 'Open in another tab. Close it there first',
  closeOtherWindowFirst: 'Open in another window. Close it there first',
  openInNewWindowNamed: 'Open {name} in a new window',
  openInNewWindow: 'Open in a new window',
  removeFromList: 'Remove from list (the folder stays)',
  delete: 'Delete',
  examples: 'Examples',
  openExample: 'Open “{name}”. Edit it and it becomes a project of your own',
  builtIn: 'built in',
  newProject: '+ New project',
  newProjectName: 'New project name',
  create: 'Create',
  livesIn: 'The open project lives in {folder}. Edits save there as you work, and changes made there load here.',
  whereDesktop:
    'The open project is stored in the app only. Save it to a folder to put it in version control, or to open it on another machine.',
  whereBrowser:
    'These projects are stored in this browser. Keep a copy on disk to put one in version control, or to open it on another machine.',
  showFolder: 'Show folder',
  saveToFolder: 'Save to folder…',
  justNow: 'just now',
  minutesAgo: { one: '{count} min ago', other: '{count} min ago' },
  hoursAgo: { one: '{count} h ago', other: '{count} h ago' },
  yesterday: 'yesterday',
  daysAgo: { one: '{count} day ago', other: '{count} days ago' },
})

/**
 * The projects list: every project the app holds.
 *
 * It is not a start screen. A first-time visitor never sees it: /app/ opens straight
 * onto the working copy (main.tsx), which is right for a single-document web app (Excalidraw,
 * tldraw and Photopea do the same), and the landing page's funnel is "See it run" in one click.
 * This is for a returning user who has a second line to build.
 *
 * Every action here is write-then-reload (see documentStore.openDocument): the boot path is the one
 * tested way to bring a project's parts, scenes and program up together, and swapping in place is
 * the trap projectFile.adoptImportedProject documents. So a click here ends the session and starts
 * the next one, which is why the outgoing document is filed first.
 *
 * Rename is inline rather than window.prompt: the Electron shell does not implement
 * prompt() (Catalog.tsx built its own dialog for the same reason), so a prompt-based rename would be
 * a dead menu item on the desktop surface.
 *
 * On the desktop a project is a folder (projectFolderSync.ts), so this list is the desktop's project
 * manager: each row says where its folder is and can show it, opening one reads the folder (the store of
 * record) rather than the library's copy, a new project gets a folder of its own, and removing a row
 * leaves the folder on disk, because "remove from the list" does not mean deleting someone's files.
 */
export function ProjectsOverlay({ store, state, onClose }: { store: EditorStore; state: EditorState; onClose: () => void }) {
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** the row being renamed, and the draft text - null when nothing is being edited */
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  /** the new-project name being typed, or null when the row is not open */
  const [creating, setCreating] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Two different questions; don't conflate them. `openId` is which document the working copy holds.
  // That makes a row undeletable, because deleting it would leave the editor on a project the library
  // no longer knows about. `onScreen` is whether that document is what you are looking at, which the
  // demo makes false: its page keeps the pointer on your
  // project (the boot adopts it, unloaded) while the viewport shows the example, so clicking your row there has
  // to be a real switch rather than a no-op that quietly closes the dialog.
  const openId = currentDocumentId()
  const onScreen = (id: string): boolean => id === openId && !state.demoSession
  /** documents some tab of this browser has open (libraryDb.documentsOpenInTabs); null until read, or unknowable */
  const [openInTabs, setOpenInTabs] = useState<ReadonlySet<string> | null>(null)
  // Another tab's document is its working copy: a delete or rename here would be undone by that tab's next save.
  const inOtherTab = (id: string): boolean => id !== openId && (openInTabs?.has(id) ?? false)
  const supported = supportsDocumentLibrary()
  const desktop = getOipProjectApi()
  /** document id -> the folder it lives in (desktop only; empty in the browser) */
  const [folders, setFolders] = useState<ReadonlyMap<string, FolderRecord>>(new Map())
  const folderOf = (id: string): string | null => folders.get(id)?.path ?? null

  const refresh = useCallback(() => {
    void getOipProjectApi()
      ?.folders()
      .then((rows) => setFolders(new Map(rows.map((r) => [r.docId, r]))))
      .catch((e: unknown) => console.warn('[oip] listing project folders failed', e))
    void documentsOpenInTabs()
      .then(setOpenInTabs)
      .catch((e: unknown) => console.warn('[oip] listing open tabs failed', e))
    void listDocuments().then((found) => {
      setDocs(found)
      // The earned moment for the durability request: they have more than one project, and they are
      // looking at the list of them. Firefox prompts for this, so asking at boot would put a storage
      // permission in front of someone who has not made anything yet (documentStore).
      if (found.length > 1) void requestDurableStorage()
    }).catch((e: unknown) => console.warn('[oip] listing projects failed', e))
  }, [])
  useEffect(refresh, [refresh])

  // focus whichever text field just appeared, so a rename or a new project is typed into rather
  // than clicked into
  useEffect(() => {
    if (editing || creating !== null) inputRef.current?.select()
  }, [editing, creating])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !editing && creating === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, creating, onClose])

  const run = (work: () => Promise<string | null>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void work()
      .then((message) => {
        // a successful open/create reloads, so this only runs when nothing happened
        if (message) setError(message)
        setBusy(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  const onOpen = (id: string): void => {
    if (onScreen(id)) return onClose() // already what you are looking at: the click means "never mind"
    // on the desktop a project open in another window is that window's: bring it forward rather than open it twice
    if (desktop && inOtherTab(id)) return onOpenInNewWindow(id)
    run(() => openStoredDocument(store, id, folderOf(id)))
  }

  /** Desktop: open the row in a window of its own, or bring forward the window that has it. */
  const onOpenInNewWindow = (id: string): void =>
    run(async () => {
      const error = await openDocumentInNewWindow(id, folderOf(id))
      if (error === null) onClose()
      return error
    })

  const onCreate = (): void => run(() => createNewProject(store, creating ?? ''))

  const onDelete = (doc: DocumentMeta): void => {
    if (doc.id === openId || inOtherTab(doc.id)) return // the open document is the working copy; leave it first
    const folder = folderOf(doc.id)
    const question =
      folder !== null
        ? t(M.confirmRemove, { name: doc.name, folder })
        : t(M.confirmDelete, { name: doc.name })
    if (typeof confirm === 'function' && !confirm(question)) return
    run(() =>
      deleteDocument(doc.id).then(async (ok) => {
        if (ok && desktop) await desktop.forget(doc.id)
        refresh()
        return ok ? null : t(M.removeFailed)
      }),
    )
  }

  const commitRename = (): void => {
    const edit = editing
    setEditing(null)
    if (!edit || edit.name.trim() === '') return
    // The open document is renamed through the store, so the title, the scene picker's group header
    // and the working copy all move together; the library follows on its next sync. Any other row is
    // a library-only relabel.
    // a shared project's record names what its write-back saves, so it is renamed too (project/sharedProject.ts)
    const shared = renameSharedProject(store, edit.id, edit.name)
    if (edit.id === openId && !shared) {
      store.renameProject(edit.name)
      setDocs((prev) => prev?.map((d) => (d.id === edit.id ? { ...d, name: edit.name.trim() } : d)) ?? null)
      return
    }
    run(() =>
      renameDocument(edit.id, edit.name).then((ok) => {
        refresh()
        return ok ? null : t(M.renameFailed)
      }),
    )
  }

  return (
    <div className="author-backdrop" data-projects-overlay onPointerDown={onClose}>
      <div className="author-dialog projects-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">
          {desktop
            ? t(M.introDesktop)
            : supported
              ? t(M.introBrowser)
              : // i18n-ok: file extension
                t(M.introSingle, { ext: '.oip' })}
        </p>

        {error !== null && <p className="projects-error">{error}</p>}

        <div className="projects-list" data-testid="projects-list">
          {docs === null && supported && <p className="projects-empty">{t(M.reading)}</p>}
          {docs !== null && docs.length === 0 && <p className="projects-empty">{t(M.empty)}</p>}
          {(docs ?? []).map((doc) => (
            <div className="projects-row" key={doc.id} data-current={onScreen(doc.id)} data-doc-id={doc.id}>
              {editing?.id === doc.id ? (
                <input
                  ref={inputRef}
                  className="projects-input"
                  value={editing.name}
                  aria-label={t(M.projectName)}
                  onChange={(e) => setEditing({ id: doc.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <button className="projects-name" disabled={busy} onClick={() => onOpen(doc.id)} title={onScreen(doc.id) ? t(M.alreadyOpen) : t(M.openNamed, { name: doc.name })}>
                  <span className="projects-label">{doc.name}</span>
                  {sharedProjectOf(doc.id) && (
                    <span className="projects-shared" title={t(M.sharedTitle)} aria-label={t(M.sharedTitle)}>
                      <PeopleIcon />
                    </span>
                  )}
                  <span className="projects-when">
                    {onScreen(doc.id) ? t(M.openNow) : inOtherTab(doc.id) ? t(desktop ? M.openInOtherWindow : M.openInOtherTab) : relativeTime(doc.updatedAt)}
                  </span>
                  {desktop && (
                    <span className="projects-path" data-folder={folderOf(doc.id) !== null}>
                      {folderOf(doc.id) ?? t(M.storedInApp)}
                    </span>
                  )}
                </button>
              )}
              <div className="projects-actions">
                {desktop?.openWindow && !onScreen(doc.id) && (
                  <button
                    className="projects-action"
                    data-testid="projects-new-window"
                    aria-label={t(M.openInNewWindowNamed, { name: doc.name })}
                    title={t(M.openInNewWindow)}
                    disabled={busy}
                    onClick={() => onOpenInNewWindow(doc.id)}
                  >
                    <RestoreIcon />
                  </button>
                )}
                {desktop && folderOf(doc.id) !== null && (
                  <button
                    className="projects-action"
                    aria-label={t(M.showNamedInFolder, { name: doc.name })}
                    title={t(M.showInFolder)}
                    onClick={() => void desktop.reveal(folderOf(doc.id)!)}
                  >
                    ⤴
                  </button>
                )}
                <button
                  className="projects-action"
                  aria-label={t(M.renameNamed, { name: doc.name })}
                  title={inOtherTab(doc.id) ? t(desktop ? M.closeOtherWindowFirst : M.closeOtherTabFirst) : t(M.rename)}
                  disabled={busy || inOtherTab(doc.id)}
                  onClick={() => setEditing({ id: doc.id, name: doc.name })}
                >
                  <PencilIcon size="1em" />
                </button>
                <button
                  className="projects-action"
                  aria-label={t(folderOf(doc.id) !== null ? M.removeNamed : M.deleteNamed, { name: doc.name })}
                  // The open document is the working copy: deleting it would leave the editor holding
                  // a project the library no longer knows about. Open another one first.
                  title={
                    doc.id === openId
                      ? t(M.openAnotherFirst)
                      : inOtherTab(doc.id)
                        ? t(desktop ? M.closeOtherWindowFirst : M.closeOtherTabFirst)
                        : folderOf(doc.id) !== null
                          ? t(M.removeFromList)
                          : t(M.delete)
                  }
                  disabled={busy || doc.id === openId || inOtherTab(doc.id)}
                  onClick={() => onDelete(doc)}
                >
                  <TrashIcon size="1em" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* The built-in example: a project like any other to open, never one of the user's until they edit it - it is
            rebuilt from this build's source each time, and nothing of it is filed until then (sceneFile.openDemoScene).
            Listed apart, so the user's own list holds only their own work: its row is styled like theirs but is not a
            `.projects-row`, which means one of the user's projects. */}
        <div className="projects-examples" data-testid="projects-examples">
          <div className="projects-examples-head">{t(M.examples)}</div>
          <div className="projects-example-row" data-current={state.demoSession}>
            <button
              className="projects-name"
              data-testid="projects-example-demo"
              disabled={busy || !commandEnabled('file.openDemo')}
              title={state.demoSession ? t(M.alreadyOpen) : t(M.openExample, { name: DEMO_SCENE_NAME })}
              onClick={() => {
                onClose()
                if (!state.demoSession) runCommand('file.openDemo')
              }}
            >
              <span className="projects-label">{DEMO_SCENE_NAME}</span>
              <span className="projects-when">{state.demoSession ? t(M.openNow) : t(M.builtIn)}</span>
            </button>
          </div>
        </div>

        {supported &&
          (creating === null ? (
            <button className="projects-new" disabled={busy} onClick={() => setCreating(UNTITLED_PROJECT)}>
              {t(M.newProject)}
            </button>
          ) : (
            <div className="projects-create">
              <input
                ref={inputRef}
                className="projects-input"
                value={creating}
                aria-label={t(M.newProjectName)}
                onChange={(e) => setCreating(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCreate()
                  if (e.key === 'Escape') setCreating(null)
                }}
              />
              <button className="projects-action projects-confirm" disabled={busy} onClick={onCreate}>
                {t(M.create)}
              </button>
            </div>
          ))}

        {/* Where this is stored, said once. A project stored in a browser can be lost to a cleared cache
            without the user ever being told where it was. A warning on a first visit would only scare,
            so the fact goes here, in the list, next to the way out of it. When a folder is linked, the
            folder is the answer instead, with a different rule: the disk takes precedence
            (projectFolderLink). */}
        <p className="projects-where" data-linked={state.linkedFolder !== null}>
          {state.folderPath !== null
            ? t(M.livesIn, { folder: state.folderPath })
            : desktop
              ? t(M.whereDesktop)
              : t(M.whereBrowser)}
          {state.folderPath !== null && desktop && (
            <button className="projects-tofolder" onClick={() => void desktop.reveal(state.folderPath!)}>
              {t(M.showFolder)}
            </button>
          )}
          {state.folderPath === null && commandEnabled('file.saveProject') && (
            <button
              className="projects-tofolder"
              onClick={() => {
                onClose() // the command opens a picker of its own; two dialogs deep helps nobody
                runCommand('file.saveProject')
              }}
            >
              {t(M.saveToFolder)}
            </button>
          )}
        </p>
      </div>
    </div>
  )
}

/** "just now" / "14 min ago" / "3 h ago" / a date past a week - enough for a list, no library needed. */
function relativeTime(at: number): string {
  const ms = Date.now() - at
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return t(M.justNow)
  if (min < 60) return t(M.minutesAgo, { count: min })
  const hours = Math.floor(min / 60)
  if (hours < 24) return t(M.hoursAgo, { count: hours })
  const days = Math.floor(hours / 24)
  if (days === 1) return t(M.yesterday)
  if (days < 7) return t(M.daysAgo, { count: days })
  return new Date(at).toLocaleDateString()
}
