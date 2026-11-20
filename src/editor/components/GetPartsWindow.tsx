// Get parts (docs/part-libraries.md): where a project gets parts it does not have, from the part libraries it reads
// (editor/parts/partLibraryUrls.ts). Sources on the left, the selected library's parts in the middle, the selected part on the
// right. Getting a part copies it into the project's library (editor/parts/partLibraries.ts installFromLibrary); placing it is
// the Parts dock's job, where it then shows in its own category tab beside the built-ins.
//
// Each listed part's offered version is downloaded and checked when the window opens (a few KB each), so Add and Update
// act at once. An update is asked first, in the shelf's change dialog, listing what changes in this project.
//
// Publishing goes the other way, and is offered here because this is where people see what others published: Publish
// a part opens Publish to Part Library (components/PublishPartDialog.tsx) for the selected part, or the project's only
// part of its own, or lets the user choose one.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { asCopyOfBuiltIn } from '../../core/builtInVersion'
import { CARGO_CAP_FORK_POCKETS, CARGO_CAP_HEAVY, CARGO_CAP_LOAD_BASE, cargoCapsOf } from '../../core/frame'
import { partChanges } from '../../core/parts/partChanges'
import { libraryCredit, libraryStatus, libraryUrl, offeredVersion } from '../../core/parts/partLibrary'
import type { LibraryPart, LibraryVersion } from '../../core/parts/partLibrary'
import type { SourceStatus } from '../../core/parts/partOrigin'
import { isCargoPackage } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { PART_SDK_LEVEL } from '../../core/parts/partSdk'
import { dialogHost, isElement } from '../dialogHost'
import { addLibrary, downloadVersion, installFromLibrary, readLibrary } from '../parts/partLibraries'
import { noteLibraryListings } from '../parts/libraryUpdates'
import { getShelfApi } from '../parts/partShelf'
import type { LibraryListing } from '../parts/partLibraries'
import { LIBRARIES_CHANGED, libraryUrls } from '../parts/partLibraryUrls'
import { documentSceneOf, type EditorState, type EditorStore } from '../store/store'
import { trapTab, useModalKeys } from './inspector/menu'
import { PartChangeDialog } from './PartChangeDialog'
import { CloseIcon, PartGlyph } from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('getParts', {
  inProject: 'In project',
  update: 'Update',
  editedHere: 'Edited here',
  differentPart: 'Different part',
  needsUpdate: 'Needs update',
  rolls: 'Rolls when it lies on its side',
  forks: 'A forklift can pick it up',
  carriesStack: 'Carries a stack on top',
  wrapBase: 'A stretch wrap starts from its base',
  nests: 'Stacks foot-in-rim on another of its kind',
  publishSelectedTitle: 'Publish “{name}” to the listed library',
  publishTitle: 'Publish a part of your project to the listed library, for everyone to get here',
  publishSelected: 'Publish “{name}”…',
  publish: 'Publish a part…',
  updateFrom: 'Update “{name}” from {library}',
  updateIntroBoth:
    "This part has changed both in this project and in the library. Updating replaces this project's changes, and every placed copy changes. What changes here, including undoing this project's edits:",
  updateIntro: 'Every placed copy in this project changes. What changes here:',
  updateAllConfirm: {
    one: 'Update {count} part from {library}: {names}? Every placed copy of them changes.',
    other: 'Update {count} parts from {library}: {names}? Every placed copy of them changes.',
  },
  version: 'Version',
  licence: 'License',
  licenceTerms: 'Code {code} · Models {assets}',
  publisher: 'Publisher',
  moreFrom: 'More from {publisher} ({count})',
  library: 'Library',
  signed: '{library} · signed by Open Industry Project',
  newerNeedsApp: 'A newer version needs a newer version of the app (Part SDK level {sdk}; this app has {app}).',
  downloadFailed: 'It could not be downloaded: {error}',
  needsNewerApp: 'Needs a newer version of the app',
  addToProject: '+ Add to project',
  downloading: 'Downloading…',
  upToDate: 'In this project. Place it from its tab in the Parts dock.',
  editedHereNote: 'In this project, changed here since it came from the library.',
  sameId: 'This project has a different part with the id {id}.',
  title: 'Get parts',
  close: 'Close',
  search: 'Search parts',
  showAll: 'Show every part again',
  fromPublisher: 'From {publisher} ✕',
  updateAll: 'Update all',
  updateAllCount: 'Update all ({count})',
  sources: 'Sources',
  libraries: 'Libraries',
  reading: 'Reading the libraries…',
  official: 'official',
  sourceMeta: '{source} · {parts}',
  unreadable: 'could not be read',
  libraryAddress: 'Library address',
  cancel: 'Cancel',
  readingOne: 'Reading…',
  add: 'Add',
  addHint: "Another publisher's library or a mirror: the address of its index.json. Settings, Part libraries removes one.",
  addHintShelf:
    "Another publisher's library or a mirror: the address of its index.json. Settings, Part libraries removes one. To share parts within a team, use the parts shelf.",
  addLibrary: '+ Add a library',
  yourParts: 'Your parts',
  noOwnParts: 'Publishing starts from a part of your own: make one with New part in the Parts dock, or Save as New Part on a built-in.',
  noLibrary: "No part library yet. Add one with Add a library: another publisher's library, or a mirror of one, by the address of its index.json.",
  emptyLibrary: 'No parts listed here yet. A part you make can be the first.',
  choose: 'Choose a part to see what it is.',
})

interface Props {
  store: EditorStore
  state: EditorState
  onClose: () => void
  /** open Publish to Part Library for this part of the project's library (this window closes) */
  onPublish: (packageId: string) => void
}

type Download = { pkg: PartPackage } | { error: string }

const keyOf = (url: string, partId: string): string => `${url}|${partId}`

/** What a status reads as on a card and in the detail pane. */
const STATUS_LABEL: Record<SourceStatus, MessageId | null> = {
  notInProject: null,
  upToDate: M.inProject,
  updateAvailable: M.update,
  editedHere: M.editedHere,
  changedInBoth: M.update,
  sameIdDifferentPart: M.differentPart,
}

/** What a cargo part is to the machines around it, in plain words (core/frame.ts cargoCapsOf). */
function whatItDoes(pkg: PartPackage): string[] {
  if (!isCargoPackage(pkg)) return []
  const out: string[] = []
  if (pkg.geometry.kind === 'rig' && pkg.geometry.links.some((l) => l.shape.kind === 'cylinder' && l.collision !== 'none')) out.push(t(M.rolls))
  const { caps, nestDepth } = cargoCapsOf(pkg)
  if (caps & CARGO_CAP_FORK_POCKETS) out.push(t(M.forks))
  if (caps & CARGO_CAP_HEAVY) out.push(t(M.carriesStack))
  if (caps & CARGO_CAP_LOAD_BASE) out.push(t(M.wrapBase))
  if (nestDepth !== undefined) out.push(t(M.nests))
  return out
}

export function GetPartsWindow({ store, state, onClose, onPublish }: Props): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const [urls, setUrls] = useState(libraryUrls)
  const [listings, setListings] = useState<LibraryListing[] | null>(null)
  const [downloads, setDownloads] = useState<ReadonlyMap<string, Download>>(new Map())
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // "More from <publisher>": the library's parts narrowed to one publisher's, shown as a removable filter by the search
  const [byPublisher, setByPublisher] = useState<string | null>(null)
  const [review, setReview] = useState<Parameters<typeof PartChangeDialog>[0] | null>(null)
  // adding a library happens here, not in Settings: Settings would open under this window
  const [adding, setAdding] = useState<{ draft: string; busy: boolean; error: string } | null>(null)
  const addSource = async (): Promise<void> => {
    if (!adding) return
    const url = adding.draft.trim()
    setAdding({ ...adding, busy: true, error: '' })
    const refused = await addLibrary(url)
    if (refused !== null) return setAdding({ draft: url, busy: false, error: refused })
    setAdding(null)
    setSourceUrl(url)
    setSelected(null)
  }
  useModalKeys(review ? () => {} : onClose, (e) => {
    if (review) return
    if (dialogRef.current) trapTab(dialogRef.current, e)
    // this listener stops every key on the window first, so a field's own onKeyDown never sees Enter
    if (e.key === 'Enter' && isElement(e.target) && e.target.dataset.testid === 'get-parts-library-url' && !adding?.busy) void addSource()
  })

  // the viewer's lists change in Settings
  useEffect(() => {
    const reread = (): void => setUrls(libraryUrls())
    window.addEventListener(LIBRARIES_CHANGED, reread)
    return () => window.removeEventListener(LIBRARIES_CHANGED, reread)
  }, [])

  // read each library, then download each part's offered version so Add and Update act at once
  const urlsKey = urls.join('\n')
  useEffect(() => {
    let live = true
    setListings(null)
    void Promise.all(urlsKey === '' ? [] : urlsKey.split('\n').map((u) => readLibrary(u))).then((read) => {
      if (!live) return
      setListings(read)
      // the Catalog's "Update" badges read the same listing (editor/parts/libraryUpdates.ts)
      noteLibraryListings(read)
      for (const l of read) {
        for (const part of l.index?.parts ?? []) {
          const { version } = offeredVersion(part)
          if (!version) continue
          void downloadVersion(l.url, part.id, version)
            .then((d) => {
              if (live) setDownloads((m) => new Map(m).set(keyOf(l.url, part.id), d))
            })
            .catch((e: unknown) => console.warn('[oip] downloading a library part failed', e))
        }
      }
    }).catch((e: unknown) => console.warn('[oip] reading the part libraries failed', e))
    return () => {
      live = false
    }
  }, [urlsKey])

  const source = listings?.find((l) => l.url === sourceUrl) ?? listings?.find((l) => l.index) ?? null
  const placedIds = useMemo(() => new Set(documentSceneOf(state).parts.flatMap((p) => (p.type === 'part' ? [p.packageId] : []))), [state])
  // the project's copy: its library's, or for a built-in the document places but has not copied yet the copy it will make
  const mineOf = (id: string): PartPackage | undefined => {
    const own = state.userPackages.find((p) => p.id === id)
    if (own || !placedIds.has(id)) return own
    const builtIn = state.bundledPackages.find((p) => p.id === id)
    return builtIn ? asCopyOfBuiltIn(builtIn, builtIn) : undefined
  }
  const statusOf = (l: LibraryListing, version: LibraryVersion, partId: string): SourceStatus => libraryStatus(mineOf(partId), version, l.firstParty)
  const fetchedOf = (l: LibraryListing, partId: string): PartPackage | undefined => {
    const d = downloads.get(keyOf(l.url, partId))
    return d && 'pkg' in d ? d.pkg : undefined
  }
  const editable = !state.readOnly

  // the project's own parts: the ones Publish to Part Library takes (commands.ts part.publish)
  const ownParts = state.userPackages.filter((p) => !p.id.startsWith('oip.'))
  const selectedOwn = (() => {
    if (state.selectedIds.length !== 1) return null
    const placed = documentSceneOf(state).parts.find((p) => p.id === state.selectedIds[0])
    return placed?.type === 'part' ? (ownParts.find((p) => p.id === placed.packageId) ?? null) : null
  })()
  const [picking, setPicking] = useState(false)
  const publishOne = (): void => {
    const only = selectedOwn ?? (ownParts.length === 1 ? ownParts[0]! : null)
    if (only) onPublish(only.id)
    else setPicking((v) => !v)
  }
  const publishButton = (
    <button
      type="button"
      className="getparts-secondary getparts-publish"
      data-testid="get-parts-publish"
      disabled={!editable}
      title={selectedOwn ? t(M.publishSelectedTitle, { name: selectedOwn.name }) : t(M.publishTitle)}
      onClick={publishOne}
    >
      {selectedOwn ? t(M.publishSelected, { name: selectedOwn.name }) : t(M.publish)}
    </button>
  )

  // who made it, kept with the project's copy (core/parts/partPackage.ts PartCredit)
  const creditOf = (l: LibraryListing, partId: string) => libraryCredit(l.index!, l.index!.parts.find((p) => p.id === partId), l.firstParty)
  const add = (l: LibraryListing, pkg: PartPackage): void => installFromLibrary(store, pkg, creditOf(l, pkg.id))
  const update = (l: LibraryListing, pkg: PartPackage, status: SourceStatus, library: string): void => {
    const mine = mineOf(pkg.id)
    if (!mine) return
    setReview({
      title: t(M.updateFrom, { name: pkg.name, library }),
      intro: status === 'changedInBoth' ? t(M.updateIntroBoth) : t(M.updateIntro),
      partId: pkg.id,
      changes: partChanges(mine, pkg),
      confirmLabel: t(M.update),
      here: { parts: documentSceneOf(state).parts, program: state.stProgram },
      onConfirm: () => installFromLibrary(store, pkg, creditOf(l, pkg.id)),
      onClose: () => setReview(null),
    })
  }

  // the parts of the selected library that have an update this project has not edited: Update all takes those
  const updatable: PartPackage[] = []
  for (const part of source?.index?.parts ?? []) {
    const { version } = offeredVersion(part)
    const fetched = source ? fetchedOf(source, part.id) : undefined
    if (source && version && fetched && statusOf(source, version, part.id) === 'updateAvailable') updatable.push(fetched)
  }
  const updateAll = (): void => {
    const names = updatable.map((p) => p.name).join(', ')
    if (!window.confirm(t(M.updateAllConfirm, { count: updatable.length, library: String(source?.index?.name), names }))) return
    for (const pkg of updatable) if (source) installFromLibrary(store, pkg, creditOf(source, pkg.id))
  }

  const q = query.trim().toLowerCase()
  const matches = (p: LibraryPart): boolean =>
    (byPublisher === null || p.publisher === byPublisher) &&
    (q === '' || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q))
  const parts = (source?.index?.parts ?? []).filter(matches)
  const chosen = parts.find((p) => p.id === selected) ?? parts[0] ?? null

  const picture = (l: LibraryListing, version: LibraryVersion | undefined, big = false): ReactElement =>
    version?.thumbnail ? (
      <img className={big ? 'getparts-picture-big' : 'getparts-picture'} src={libraryUrl(l.url, version.thumbnail)} crossOrigin="anonymous" alt="" draggable={false} />
    ) : (
      <span className="getparts-glyph"><PartGlyph /></span>
    )

  const detail = (l: LibraryListing, part: LibraryPart): ReactElement => {
    const { version, newer } = offeredVersion(part)
    const fetched = fetchedOf(l, part.id)
    const download = downloads.get(keyOf(l.url, part.id))
    const status = version ? statusOf(l, version, part.id) : null
    const library = l.index!.name
    return (
      <div className="getparts-detail" data-testid="get-parts-detail" data-part-id={part.id}>
        {picture(l, version, true)}
        <h3>{part.name}</h3>
        {part.description && <p className="getparts-description">{part.description}</p>}
        {fetched && whatItDoes(fetched).length > 0 && (
          <ul className="getparts-does">
            {whatItDoes(fetched).map((d) => (
              <li key={d}>✓ {d}</li>
            ))}
          </ul>
        )}
        <dl className="getparts-facts">
          {version && (
            <>
              <dt>{t(M.version)}</dt>
              <dd>
                {part.versions.indexOf(version) + 1} · {version.published}
              </dd>
            </>
          )}
          <dt>{t(M.licence)}</dt>
          <dd>
            {t(M.licenceTerms, { code: l.index!.licence.code, assets: l.index!.licence.assets })}
          </dd>
          {part.publisher && (
            <>
              <dt>{t(M.publisher)}</dt>
              <dd data-testid="get-parts-publisher">
                <a href={`https://github.com/${part.publisher}`} target="_blank" rel="noreferrer">
                  {part.publisher}
                </a>
                {byPublisher !== part.publisher && l.index!.parts.filter((p) => p.publisher === part.publisher).length > 1 && (
                  <>
                    {' · '}
                    <button type="button" className="getparts-link" data-testid="get-parts-more-from" onClick={() => setByPublisher(part.publisher!)}>
                      {t(M.moreFrom, { publisher: part.publisher, count: l.index!.parts.filter((p) => p.publisher === part.publisher).length })}
                    </button>
                  </>
                )}
              </dd>
            </>
          )}
          {/* the project's own libraries list no publisher: their parts are credited to the project, as the copy will be */}
          {!part.publisher &&
            (() => {
              const credit = creditOf(l, part.id)
              return credit.by ? (
                <>
                  <dt>{t(M.publisher)}</dt>
                  <dd data-testid="get-parts-publisher">
                    {credit.url ? (
                      <a href={credit.url} target="_blank" rel="noreferrer">
                        {credit.by}
                      </a>
                    ) : (
                      credit.by
                    )}
                  </dd>
                </>
              ) : null
            })()}
          <dt>{t(M.library)}</dt>
          <dd title={l.url}>
            {l.signed ? t(M.signed, { library }) : library}
          </dd>
        </dl>
        {newer && <p className="getparts-note">{t(M.newerNeedsApp, { sdk: newer.sdk, app: PART_SDK_LEVEL })}</p>}
        {download && 'error' in download && <p className="getparts-note">{t(M.downloadFailed, { error: download.error })}</p>}
        <div className="getparts-actions">
          {!version ? (
            <span className="getparts-status">{t(M.needsNewerApp)}</span>
          ) : status === 'notInProject' ? (
            <button type="button" className="getparts-primary" data-testid="get-parts-add" disabled={!editable || !fetched} onClick={() => fetched && add(l, fetched)}>
              {fetched ? t(M.addToProject) : t(M.downloading)}
            </button>
          ) : status === 'updateAvailable' || status === 'changedInBoth' ? (
            <button type="button" className="getparts-primary" data-testid="get-parts-update" disabled={!editable || !fetched} onClick={() => fetched && update(l, fetched, status, library)}>
              {t(M.update)}
            </button>
          ) : (
            <span className="getparts-status" data-testid="get-parts-status">
              {status === 'upToDate'
                ? t(M.upToDate)
                : status === 'editedHere'
                  ? t(M.editedHereNote)
                  : t(M.sameId, { id: part.id })}
            </span>
          )}
        </div>
      </div>
    )
  }

  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div className="author-dialog getparts-dialog" data-testid="get-parts" ref={dialogRef} role="dialog" aria-label={t(M.title)} onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title)}</h2>
          <button className="author-close" aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="getparts-bar">
          <input
            className="getparts-search"
            data-testid="get-parts-search"
            type="search"
            placeholder={t(M.search)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // typing must not drive the editor's shortcuts; Escape still closes the window
            onKeyDown={(e) => {
              if (e.key !== 'Escape') e.stopPropagation()
            }}
          />
          {byPublisher !== null && (
            <button type="button" className="getparts-chip" data-testid="get-parts-publisher-filter" title={t(M.showAll)} onClick={() => setByPublisher(null)}>
              {t(M.fromPublisher, { publisher: byPublisher })}
            </button>
          )}
          <button type="button" className="getparts-secondary" data-testid="get-parts-update-all" disabled={!editable || updatable.length === 0} onClick={updateAll}>
            {updatable.length > 0 ? t(M.updateAllCount, { count: updatable.length }) : t(M.updateAll)}
          </button>
        </div>
        <div className="getparts-body">
          <nav className="getparts-sources" aria-label={t(M.sources)}>
            <div className="getparts-section">{t(M.libraries)}</div>
            {listings === null && urls.length > 0 && <p className="getparts-hint">{t(M.reading)}</p>}
            {listings?.map((l) => (
              <button
                key={l.url}
                type="button"
                className={`getparts-source${source === l ? ' active' : ''}`}
                data-testid="get-parts-source"
                data-library-id={l.index?.id ?? ''}
                title={l.error ? `${l.url}: ${l.error}` : l.url}
                disabled={!l.index}
                onClick={() => {
                  setSourceUrl(l.url)
                  setSelected(null)
                  setByPublisher(null)
                }}
              >
                <span className="getparts-source-name">{l.index?.name ?? new URL(l.url).host}</span>
                <span className="getparts-source-meta">{l.index ? t(M.sourceMeta, { source: l.firstParty ? t(M.official) : new URL(l.url).host, parts: l.index.parts.length }) : t(M.unreadable)}</span>
              </button>
            ))}
            {adding ? (
              <div className="getparts-add-form">
                <input
                  className="getparts-search"
                  data-testid="get-parts-library-url"
                  type="url"
                  // i18n-ok: an example address
                  placeholder="https://.../index.json"
                  aria-label={t(M.libraryAddress)}
                  autoFocus
                  value={adding.draft}
                  onChange={(e) => setAdding({ ...adding, draft: e.target.value, error: '' })}
                />
                {adding.error && <p className="getparts-hint getparts-error">{adding.error}</p>}
                <div className="getparts-add-row">
                  <button type="button" className="getparts-secondary" onClick={() => setAdding(null)}>
                    {t(M.cancel)}
                  </button>
                  <button type="button" className="getparts-secondary" data-testid="get-parts-add-library-confirm" disabled={adding.busy || adding.draft.trim() === ''} onClick={() => void addSource()}>
                    {adding.busy ? t(M.readingOne) : t(M.add)}
                  </button>
                </div>
                <p className="getparts-hint">{t(getShelfApi() ? M.addHintShelf : M.addHint)}</p>
              </div>
            ) : (
              <button type="button" className="getparts-secondary getparts-add-library" data-testid="get-parts-add-library" onClick={() => setAdding({ draft: '', busy: false, error: '' })}>
                {t(M.addLibrary)}
              </button>
            )}
            <div className="getparts-section getparts-publish-head">{t(M.yourParts)}</div>
            {publishButton}
            {picking && (
              <div className="getparts-pick" data-testid="get-parts-publish-pick">
                {ownParts.length === 0 ? (
                  <p className="getparts-hint">{t(M.noOwnParts)}</p>
                ) : (
                  ownParts.map((p) => (
                    <button key={p.id} type="button" className="getparts-source" data-testid="get-parts-publish-choice" data-part-id={p.id} onClick={() => onPublish(p.id)}>
                      <span className="getparts-source-name">{p.name}</span>
                      <span className="getparts-source-meta">{p.id}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </nav>
          <div className="getparts-grid" role="list">
            {urls.length === 0 && (
              <p className="getparts-hint">{t(M.noLibrary)}</p>
            )}
            {source?.index && source.index.parts.length === 0 && (
              <div className="getparts-empty" data-testid="get-parts-empty">
                <p className="getparts-hint">{t(M.emptyLibrary)}</p>
                {publishButton}
              </div>
            )}
            {source?.index &&
              parts.map((part) => {
                const { version } = offeredVersion(part)
                const status = version ? statusOf(source, version, part.id) : null
                const labelId = status ? STATUS_LABEL[status] : M.needsUpdate
                const label = labelId ? t(labelId) : ''
                return (
                  <button
                    key={part.id}
                    type="button"
                    role="listitem"
                    className={`getparts-card${chosen?.id === part.id ? ' active' : ''}`}
                    data-testid="get-parts-card"
                    data-part-id={part.id}
                    data-status={status ?? 'needsNewerApp'}
                    onClick={() => setSelected(part.id)}
                  >
                    {picture(source, version)}
                    <span className="getparts-card-name">{part.name}</span>
                    {label && <span className={`getparts-badge is-${status ?? 'old'}`}>{label}</span>}
                  </button>
                )
              })}
          </div>
          <aside className="getparts-side">{source?.index && chosen ? detail(source, chosen) : <p className="getparts-hint">{t(M.choose)}</p>}</aside>
        </div>
      </div>
      {review && <PartChangeDialog {...review} />}
    </div>,
    host,
  )
}
