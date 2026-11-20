// First: part code (geometry, idle Use) runs in this realm, so it locks down before anything else runs
// (core/lockdownBoot.ts, docs/part-sandbox.md)
import '../core/lockdownBoot'
import { createRoot } from 'react-dom/client'
import { blankScene, setNextIdSuffix } from '../core/scene/scene'
import { DEFAULT_SIM_HZ } from '../core/types'
import type { SceneJSON, SimRate } from '../core/types'
import type { Controller } from '../core/controller'
import type { DemoSeed } from '../collab/demoRoom'
import {
  getCollabSnapshot,
  getLocalActorName,
  getPeers,
  initCollabSession,
  isLocalDragging,
  remoteDragPoses,
  setCollabContext,
  setLocalRunning,
  setLocalStream,
  setLocalWatching,
  setLocalSelection,
  setRoomCodeGate,
  setRoomState,
  subscribeCollab,
  subscribePeers,
} from '../collab/session'
import { consumeSeedMark, resolveRoom, type ResolvedRoom, type SeedKind } from '../collab/rooms'
import { SimClient } from '../sim/client'
import { getPartThumbnails, renderPackageThumbnails } from '../render/viewport/thumbnails'
import { getPackage, registerPackage } from '../core/parts/partRegistry'
import type { PackageManifest } from '../core/parts/partPackage'
import { partSandboxActive } from '../core/parts/partSandbox'
import { DESKTOP_SHELL } from './desktop/desktopMenuBridge'
import { prefetchSceneAssets } from './prefetchSceneAssets'
import { prefetchThumbnails } from '../render/prefetch'
import { bundledBehaviors, bundledThumbnailIds, loadBundledExamples, registerBundledPackages } from './parts/bundledExamples'
import { speculativeFetches } from '../render/gltf'
import { App } from './App'
import { AppCrashBoundary } from './components/CrashDialog'
import { createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM } from './demo/demoScenes'
import { DEFAULT_SCAN_MS } from './program/stProgram'
import { importSceneText, loadSceneText, sceneFileText } from './project/sceneFile'
import type { ProjectJSON } from '../core/project/project'
import {
  isWorkingCopyKey,
  keepPendingWrite,
  loadStoredProject,
  noteWorkingCopyWrite,
  onWorkingCopySuperseded,
  onWorkingCopyWrite,
  openWorkingCopy,
  parkSplitOff,
  storedAssetTexts,
  unopenedProject,
} from './project/projectFile'
import { onLocalAssetsStored, supportsLocalAssets, sweepLocalAssets } from './project/localAssets'
import { startSplitFiling } from './project/projectSplit'
import { currentDocumentId } from './project/documentStore'
import { EditorStore } from './store/store'
import { liveChannel } from './live/liveChannel'
import { followTarget, type FollowTarget } from './live/followTarget'
import { registerRoomEntry } from './roomEntry'
import { claimRoom, isStoppingSharing, ownSharedProject, setRoomNameWriter, sharedDemo, sharedProjectOf, startWriteBack } from './project/sharedProject'
import { soloUrl } from './project/roomCopy'
import { defaultCollabUrl, linkCollabServer } from '../collab/collabServer'
import { initKeymapPrefs } from './keymapPrefs'
import { initNavPrefs } from './navigationPrefs'
import { initLanguage } from './autoTranslate'
import { followAppearance } from './appearance'
import { isFreshNavigation, isPhoneViewport, phoneOpensDemo } from './demo/phoneDemo'
import './styles.css'

// iOS reports "launched from the home screen" only through this non-standard flag - the
// display-mode media query is the Android/Chrome route - and styles.css needs the signal in
// CSS to pin #root to the screen instead of trusting a height unit (see the .standalone rules there). Stamped
// at module scope so it is applied before the first paint, not a frame into it.
if ((navigator as Navigator & { standalone?: boolean }).standalone) {
  document.documentElement.classList.add('standalone')
}

// Light / dark / follow the OS (appearance.ts). app/index.html already stamped the stored choice
// before the boot skeleton painted; this keeps it current from here on.
followAppearance(document)

/**
 * The user's persisted solo document (the project autosave's active scene and the program bound to
 * it), or a default building. Read as one unit, because that is what a room seed has to carry: a seed
 * that took its program from anywhere else could produce a room with a layout and no logic.
 */
function soloDocOrDefault(): { scene: SceneJSON; stProgram: string; stScanMs: number; controller: Controller | null; stDialect?: string; simHz: SimRate; library: Set<string> } {
  const loaded = loadStoredProject()
  return {
    scene: loaded?.scene ?? blankScene(),
    stProgram: loaded?.stProgram ?? '',
    stScanMs: loaded?.stScanMs ?? DEFAULT_SCAN_MS,
    controller: loaded?.controller ?? null,
    ...(loaded?.stDialect !== undefined ? { stDialect: loaded.stDialect } : {}),
    simHz: loaded?.simHz ?? DEFAULT_SIM_HZ,
    // the parts this user authored or forked: they seed a room as edits, not snapshots (schema.editedPackageIds)
    library: new Set((loaded?.library ?? []).map((p) => p.id)),
  }
}

/**
 * The demo as a room holds it (collab/demoRoom.ts): the same scene and program the solo `?scene=demo` boot opens.
 * Built with no room id suffix, because every client has to build the same demo to tell whether a room holds it,
 * and room mode suffixes minted ids with this client's id (setNextIdSuffix), which is put back as `roomSuffix`.
 */
function demoSeed(roomSuffix: string): DemoSeed {
  setNextIdSuffix('')
  try {
    return { scene: createPlcDemoScene(), stProgram: DEMO_PROGRAM, stScanMs: DEFAULT_SCAN_MS, controller: DEMO_CONTROLLER, simHz: DEFAULT_SIM_HZ }
  } finally {
    setNextIdSuffix(roomSuffix)
  }
}

// the user's rebindings, before anything can listen for a key (editor/keymapPrefs.ts)
initKeymapPrefs()
// the camera's mouse style (middle orbits or pans), before the view reads it (editor/navigationPrefs.ts)
initNavPrefs()
// the browser's language, before anything renders a string (editor/autoTranslate.ts)
initLanguage()

const store = new EditorStore()
const sim = new SimClient()
// a gesture's autosave trails it by a moment (store.deferPersist): flush it before the page can go away.
// `hidden` covers a mobile tab the OS may kill without a pagehide.
// The working copy's row write is asynchronous, so one still in flight is also kept where a closing page can write it.
const flushOnHide = (): void => {
  store.flushPersist()
  keepPendingWrite()
}
addEventListener('pagehide', flushOnHide)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushOnHide()
})

/**
 * Park an older multi-scene working copy's other scenes (projectFile.parkSplitOff) before the boot saves over it. If
 * they cannot be parked, nothing may be saved: the session goes read-only rather than lose them.
 */
function keepSplitOff(splitOff: readonly ProjectJSON[] | undefined): void {
  if (!splitOff || splitOff.length === 0) return
  const parked = parkSplitOff(splitOff)
  if (parked.ok) return
  store.setReadOnly(true)
  store.showSaveNotice('Opened read-only', `This project holds several scenes, and they could not be kept apart for filing: ${parked.message}`)
}

/** The solo (no-room) boot path: demo / autosave / default. The working copy has been read (projectFile.openWorkingCopy). */
function bootSolo(): void {
  // This build's own parts, before any saved document is loaded: that document's snapshot of a built-in part must
  // lose to the part itself, and it only does once the id is registered (registerBundledPackages).
  registerBundledPackages()
  // The project autosave: its scene, ST program and part library, with a
  // one-time migration from the legacy single-scene keys baked in. Returns null only on a first-ever visit.
  const saved = loadStoredProject()
  let demo = new URLSearchParams(location.search).get('scene') === 'demo'
  let phoneDemo = false
  // A phone can't author, so an empty scene is a dead end there: it gets the demo instead, through the same
  // boot as the landing CTA. The param goes in the address bar so everything after treats it as that boot
  // (a reload keeps the demo, opening a project clears it, an edit forks it). Rules: phoneDemo.ts.
  if (!demo && phoneOpensDemo({ phone: isPhoneViewport(), freshNavigation: isFreshNavigation(), stored: saved, unopened: unopenedProject() !== null })) {
    const url = new URL(location.href)
    url.searchParams.set('scene', 'demo')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    demo = true
    phoneDemo = true
  }
  // The landing page's "See it run" CTA links to /app/?scene=demo: open straight into the
  // ready-made PLC sortation demo (scene + paired program) so a first-time visitor sees
  // a working line, not an empty warehouse. persist:false keeps it from overwriting a
  // returning user's saved autosave.
  if (demo) {
    // Adopt a returning user's project first, ownership only: no scene switch, no tab UI, nothing they
    // can see (adoptOnly, store.loadProject). Then the demo's first persisting edit is saved as a
    // new scene beside their work (store.stashDemoSession) instead of assembling a one-scene project over
    // PROJECT_KEY, which would destroy their other scenes, its program, and the project name. Their
    // library is not made live: it holds a copy of every part their project uses, and the demo runs this
    // build's parts (store.enterDemoSession).
    store.setUnopenedProject(unopenedProject())
    keepSplitOff(saved?.splitOff)
    if (saved) store.loadProject(saved.project, { adoptOnly: true })
    else store.restoreUserPackages() // no project doc: the legacy authored-parts key is all there is
    // The same ephemeral demo view the in-app Demo action opens (store.enterDemoSession): loaded
    // persist:false on both halves, so opening on the demo never overwrites a returning user's saved
    // scene or program, and it occupies no scene slot. The demo is rebuilt from source on every visit to
    // this URL, so it always matches the running build; the first persisting edit forks it into the
    // user's own named scene and retires the ?scene=demo param (store.stashDemoSession), so a later
    // reload opens that work rather than the demo over the top of it.
    //
    // bank:false: this visit opens on the demo, so there is no scene of theirs on screen to bank.
    store.enterDemoSession(createPlcDemoScene(), DEMO_PROGRAM, { bank: false, controller: DEMO_CONTROLLER })
    // nobody asked for it, and a phone hides the Example badge that would say what this is
    if (phoneDemo) store.showSaveNotice('Showing the example', 'Phones can view and run a line, not build one, so this opened on the built-in example. Your projects are in the Project menu.')
    return
  }
  // A stored project that could not be opened is published before anything below tries to save: those saves
  // are refused (projectFile.saveStoredProject), and the banner has to say why and offer the way out.
  store.setUnopenedProject(unopenedProject())
  if (saved) {
    // An older multi-scene working copy: its other scenes are parked before anything below saves over it
    // (projectSplit.ts files them once the app is up)
    keepSplitOff(saved.splitOff)
    // Adopt the project: loads its scene live and seeds the library.
    store.loadProject(saved.project)
    // Lock in the legacy→project migration / refresh the doc now that the project is in state. (Refused
    // while an unopened project holds the working copy - this write would otherwise replace it.)
    store.persistProject()
  } else {
    store.loadScene(blankScene())
    store.restoreUserPackages()
  }
}

/**
 * Every tab of the app on this origin shares one working copy, and a save writes the whole document, so two
 * tabs editing at once would erase each other's work in silence. Once another tab writes something other
 * than what this one last saw, this tab yields: it stops saving (projectFile refuses from then on) and goes
 * view-only, with a banner whose Reload makes it the tab holding the latest copy. The same yield fires when a
 * save finds the other tab's write before its storage event has arrived.
 *
 * Solo only: in a room the collab doc is the document and this tab never writes the working copy.
 */
function watchOtherTabs(): void {
  // a tab that has since entered a room in place (roomEntry.ts) writes no working copy, so another tab's has no claim on it
  onWorkingCopySuperseded(() => {
    if (!store.getState().collab) store.yieldToOtherTab()
  })
  addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage) return
    // key null is another tab's localStorage.clear(): the working copy is gone from under this one too
    if (e.key === null || isWorkingCopyKey(e.key)) noteWorkingCopyWrite(e.key === null ? null : e.newValue)
  })
}

/**
 * The collaborative (room) boot path. Connects the Y.Doc + IndexedDB + Hocuspocus, seeds an
 * empty room from the user's current scene (so Share carries their work), syncs the store
 * from the doc, then wires the two-way bridge. Awaits first sync so we don't flash an empty
 * scene before remote state arrives.
 */
const sameTarget = (a: FollowTarget | null, b: FollowTarget | null): boolean => a === b || (!!a && !!b && a.who === b.who && a.stream === b.stream && a.why === b.why)

/**
 * A room's live share (collab/liveShare.ts, docs/live-share.md). Anyone running can be watched: an editor's run is
 * announced to the server, and its frames go out only while someone follows it. This client follows the run
 * live/followTarget.ts picks, and publishes whose run it draws. Registered before the first sync, so the server's
 * word on the owner and the spotlight, sent on joining, is not missed.
 */
function joinLiveShare(
  provider: {
    sendStateless(payload: string): void
    on(event: 'stateless', cb: (data: { payload: string }) => void): unknown
    on(event: 'synced', cb: (data: { state: boolean }) => void): unknown
  },
  live: typeof import('../collab/liveShare'),
  canShare: boolean,
  queued: () => number,
): void {
  const send = (payload: string): void => provider.sendStateless(payload)
  const receiver = new live.LiveShareReceiver(send, {
    frame: (f, watch) => liveChannel.in?.frame(f, watch),
    end: () => liveChannel.in?.end(),
  })
  let sender: InstanceType<typeof live.LiveShareSender> | null = null
  provider.on('stateless', ({ payload }) => {
    const m = live.parseLiveMessage(payload)
    if (!m) return
    if (m.kind === 'o') {
      const owner = m.stream === '-' ? null : Number(m.stream)
      setRoomState(owner !== null && Number.isSafeInteger(owner) ? owner : null, m.body === '1')
    } else if (m.kind === 'w' || m.kind === 'q') sender?.accept(m.kind, m.stream, m.body)
    else receiver.accept(m.kind, m.stream, m.body)
  })

  // this client's run: announced while it runs (not a Part Editor test run), so the others can watch it
  const syncSender = (): void => {
    const { running, packageEdit } = store.getState()
    const want = canShare && running && !packageEdit
    if (want && !sender) {
      sender = new live.LiveShareSender(send, undefined, queued)
      liveChannel.out = sender
      setLocalStream(sender.stream)
    } else if (!want && sender) {
      sender.end()
      sender = null
      liveChannel.out = null
      setLocalStream(null)
    }
  }

  // whose run to draw, again on any change to this client, the room or the people in it
  let spotlight = false
  let watching: number | null | undefined
  const follow = (): void => {
    const s = store.getState()
    const c = getCollabSnapshot()
    if (c.spotlight !== spotlight) {
      spotlight = c.spotlight
      // a new spotlight asks again, though the last was dismissed, and brings a moved view back to the owner's
      if (spotlight && (s.spotlightDismissed || s.liveViewDetached)) return store.setState({ spotlightDismissed: false, liveViewDetached: false })
    }
    // someone picked who left is not waited for
    if (s.liveWatch !== null && !getPeers().some((p) => p.clientId === s.liveWatch)) return store.setState({ liveWatch: null })
    const target = followTarget({
      self: c.selfId,
      running: s.running,
      readOnly: s.readOnly,
      picked: s.liveWatch,
      owner: c.owner,
      spotlight: c.spotlight,
      dismissed: s.spotlightDismissed,
      runners: c.runners,
    })
    // a spotlight never switches someone mid-drag: it takes them when they let go
    if (target?.why === 'spotlight' && !sameTarget(target, s.liveTarget) && isLocalDragging()) return
    // someone new to follow is followed from their own view (controller/liveCamera.ts)
    if (!sameTarget(target, s.liveTarget)) return store.setState({ liveTarget: target, ...(target?.who !== s.liveTarget?.who ? { liveViewDetached: false } : {}) })
    receiver.follow(target?.stream ?? null)
    // published while waiting too, so the one followed sends their camera before they run
    const following = target?.who ?? null
    if (following !== watching) setLocalWatching((watching = following))
  }
  const update = (): void => {
    syncSender()
    follow()
  }
  store.subscribe(update)
  subscribeCollab(follow)
  subscribePeers(follow)
  // a reconnect is a new connection to the server, which has forgotten this one's run and whom it follows
  let synced = false
  provider.on('synced', ({ state }) => {
    if (!state) return
    if (synced) {
      if (sender) {
        sender = null
        liveChannel.out = null
      }
      syncSender()
      receiver.refollow()
    }
    synced = true
  })
  update()
}

/**
 * `seedHere`: this tab minted the room and enters it in place (roomEntry.ts), so it says what seeds the room. Opened
 * from a link, the seed mark a minting tab left before reloading says it instead (rooms.ts).
 */
async function bootRoom(resolved: ResolvedRoom, seedHere: SeedKind | null = null): Promise<void> {
  // `resolved` is the ?room= value classified (rooms.ts resolveRoom) into the server doc name +
  // auth token; view-ness follows from whether we hold the edit secret, so the server enforces it too.
  const { room } = resolved
  store.setCollabMode(true)
  // view-only: authoring is disabled and the bridge never writes to the doc
  if (resolved.view) store.setReadOnly(true)
  // load the collaboration stack (yjs + hocuspocus + y-indexeddb + y-codemirror) only for
  // rooms, so the solo bundle stays lean
  const [{ connectRoom, seedIfEmpty, collabUrl }, schema, { CollabBridge }, { createStCollabExtension }, trust, demoRoom, wasShipped, roomAssets, liveShare] = await Promise.all([
    import('../collab/provider'),
    import('../collab/schema'),
    import('../collab/bridge'),
    import('../collab/stBinding'),
    import('../collab/codeTrust'),
    import('../collab/demoRoom'),
    import('./parts/shippedBehaviors').then((m) => m.loadShippedBehaviors()),
    import('../collab/roomAssets'),
    import('../collab/liveShare'),
  ])
  // a part's embedded models live in the collab server's asset store by hash (collab/roomAssets.ts), which an editor
  // may add to. Set before anything seeds or reads the room's packages: a read starts fetching the hashes it names.
  roomAssets.configureRoomAssets({ base: roomAssets.assetBaseFor(collabUrl()), room: resolved.docName, token: resolved.view ? null : resolved.token })
  // A link that names another server sends this tab's edits, presence and name there. Harmless for a view link and
  // what a self-hosted room is for, but anyone can write such a link, so say where the room is.
  const otherServer = linkCollabServer()
  if (otherServer && otherServer !== defaultCollabUrl()) {
    store.showSaveNotice(
      'This shared project is on another server',
      `This shared project is kept on ${new URL(otherServer).host}, not on the Open Industry Project's server. What you do in it goes there. If you did not expect that, close this tab.`,
    )
  }
  const { ydoc, provider, idb, whenSynced, serverSynced } = connectRoom(resolved)
  // Its owner closed the room (Stop sharing, server/roomOwners.mjs): told while in it, or refused on the way in. Back to
  // the app on its own, saying why, rather than on a copy of the room this browser happens to have cached.
  const leaveClosed = (): void => {
    if (isStoppingSharing()) return // this tab is the one closing it, and is on its way already
    void idb.clearData()
    const url = new URL(soloUrl(location.href), location.href)
    url.searchParams.set('closed', '1')
    location.replace(url.toString())
  }
  provider.on('authenticationFailed', ({ reason }: { reason?: string }) => {
    if (reason === 'room-closed') leaveClosed()
  })
  provider.on('stateless', ({ payload }: { payload: string }) => {
    if (payload === 'room1|closed|') leaveClosed()
  })
  // room-unique part ids so two clients minting from the same count don't collide
  const idSuffix = '~' + ydoc.clientID.toString(36)
  setNextIdSuffix(idSuffix)
  initCollabSession(room, provider)
  joinLiveShare(provider, liveShare, !resolved.view, () => provider.configuration.websocketProvider.webSocket?.bufferedAmount ?? 0)
  await whenSynced
  // An empty room is seeded from the creator's current scene + PLC program (Share's
  // payload) - but only by the tab that minted the room, so opening a mistyped or stale
  // link can't upload this browser's private solo scene into a foreign room id. A viewer
  // never seeds.
  const mintedHere = seedHere ?? consumeSeedMark(room)
  let seededCode: string[] = []
  if (!resolved.view && (mintedHere === 'demo' || demoRoom.isDemoRoom(ydoc))) {
    // Shared from the untouched demo: the room holds the demo until someone edits it, so an editor on a build with a
    // newer demo brings it up to date (collab/demoRoom.ts). Its packages are this app's own, so no code to note.
    demoRoom.syncDemoRoom(ydoc, demoSeed(idSuffix), {
      minted: mintedHere === 'demo',
      serverSynced: serverSynced(),
      ...(__BUILD_TIME__ > 0 ? { build: __BUILD_TIME__ } : {}),
    })
  } else if (!resolved.view && mintedHere === 'scene') {
    // scene and program from the same document, so a shared room can't get the layout without
    // the logic (see soloDocOrDefault)
    const solo = soloDocOrDefault()
    if (seedIfEmpty(ydoc, solo.scene, solo.stProgram, solo.stScanMs, solo.simHz, solo.controller, solo.stDialect, solo.library))
      seededCode = (solo.scene.packages ?? []).map((p) => p.behavior)
  }
  // Whose part code may run here (collab/codeTrust.ts): this app's own parts, in this build or any earlier one (a
  // room keeps a snapshot of the built-ins it places, shippedBehaviors.ts), and code this browser wrote itself,
  // whether just now (the seed, a part authored in the room) or on an earlier visit (remembered by fingerprint).
  // The rest of the room's code: where the realm is locked down it runs in the part sandbox (docs/part-sandbox.md),
  // on the desktop too, whose main process also limits what an escape could reach (folder grants, endpoint consent).
  // Where lockdown failed it waits until the user allows the room (RoomCodePrompt), which this browser then remembers.
  const shipped = bundledBehaviors()
  const shippedCode = new Set(shipped.values())
  const sandboxed = partSandboxActive()
  // Safe open: the room's foreign code is held this time even where it would run - asked for with `?nocode`, or
  // because the last open of this room never finished (it froze or crashed the page; codeTrust.ts recovery). The
  // sandbox confines part code but cannot stop it spinning, so this is how a room with a hostile part stays openable.
  const safe: 'link' | 'recovered' | null = new URLSearchParams(location.search).has('nocode')
    ? 'link'
    : sandboxed && trust.roomOpenDidNotFinish(resolved.docName)
      ? 'recovered'
      : null
  const runsByDefault = sandboxed || trust.isRoomCodeTrusted(resolved.docName)
  const gate = new trust.PackageGate(
    { isFirstParty: (src) => shippedCode.has(src) || wasShipped(src), sourceFor: (id) => shipped.get(id) },
    safe ? false : runsByDefault,
    (src) => void trust.rememberOwnCode(src),
  )
  for (const src of seededCode) gate.noteOwn(src)
  for (const src of await trust.ownCodeAmong(schema.readPackages(ydoc).map((p) => p.behavior))) gate.noteOwn(src)
  // From the moment foreign code may run until the page has shown it survives: a normal leave (pagehide) or 30 s of
  // staying responsive clears the mark. A frozen tab that gets closed, or a crash, fires neither, so the mark stays
  // and the next open is a safe one. Armed only when there is someone else's code to run.
  const armRecovery = (): void => {
    if (!sandboxed || gate.getForeign().length === 0) return
    trust.markRoomOpening(resolved.docName, Date.now())
    const finished = (): void => trust.roomOpenFinished(resolved.docName)
    window.addEventListener('pagehide', finished, { once: true })
    window.setTimeout(finished, 30000)
  }
  // armed whenever someone else's code is about to run: at the first review, when a peer adds more mid-session, or
  // when the user allows a held room (the gate notifies on each of those)
  let foreignArmed = 0
  gate.subscribe(() => {
    const n = gate.getForeign().length
    if (gate.trusted && n > foreignArmed) armRecovery()
    foreignArmed = gate.trusted ? Math.max(foreignArmed, n) : foreignArmed
  })
  const unsubRemember = gate.subscribe(() => {
    if (!gate.trusted) return
    // a sandboxed room runs its code on every normal open, so only an unsandboxed yes needs remembering
    if (!sandboxed) trust.rememberRoomCodeTrust(resolved.docName)
    unsubRemember()
  })
  setRoomCodeGate(gate, { sandboxed, docName: resolved.docName, safe })
  // register the room's custom-part packages before materializing the scene, so custom parts resolve on the
  // first paint; the bridge keeps them in sync thereafter. Both go through the gate: the scene embeds the
  // packages too, and the sim runs an embedded copy when the registry lacks the id.
  // This build's own parts go first: the room holds a snapshot of every built-in part it places, and only a
  // client that already knows which ids it ships can tell that snapshot (ignored) from a fork (store
  // applyRemotePackages). The viewport's later call is a no-op re-register.
  loadBundledExamples(store)
  // (the review notifies the gate's listeners, which arm the recovery mark before any of this code can run)
  store.applyRemotePackages(gate.review(schema.readPackages(ydoc)), schema.editedPackageIds(ydoc))
  store.applyRemote(gate.admitScene(schema.docToScene(ydoc)))
  // the demo, entered in place, is the room's document now and no longer a preview (a room link never opens one)
  if (store.getState().demoSession) store.setState({ demoSession: false })
  // start the room scene's asset downloads now, not when the view mounts (see prefetchSceneAssets)
  prefetchSceneAssets(store.getState().scene)
  // the bridge also renders peers' live drags (over awareness, off the doc) via this presence source;
  // getLocalActorName stamps this client's display name onto its shared edit-feed entries
  // and this build's stamp: an editor claims the room for it, and yields (view-only) to a newer build's claim
  new CollabBridge(store, ydoc, { subscribe: subscribePeers, remoteDragPoses, isLocalDragging }, resolved.view, getLocalActorName, gate, __BUILD_TIME__ > 0 ? __BUILD_TIME__ : undefined)
  // expose the shared ST program (Y.Text) + its CodeMirror binding to the editor panel
  const ytext = ydoc.getText(schema.ST_PROGRAM_TEXT)
  setCollabContext({ ytext, stExtension: createStCollabExtension(ytext, provider.awareness) })
  // broadcast this client's selection + run state for presence ("who's editing what",
  // and who's running a private preview)
  store.subscribe(() => {
    setLocalSelection(store.getState().selectedIds)
    setLocalRunning(store.getState().running)
  })
  // a project of this browser's own, shared: the room's document flows back into it, and this browser registers as its
  // owner, which is what lets Stop sharing close it (project/sharedProject.ts, server/roomOwners.mjs)
  // The room carries the project's name, so everyone in it sees what they are in: written by its owner, read by the rest
  // (a room from before names were written reads as "Shared project").
  const own = ownSharedProject()
  if (own && !resolved.view) {
    schema.writeProjectName(ydoc, own.project)
    setRoomNameWriter((name) => schema.writeProjectName(ydoc, name))
  } else {
    const readName = (): void => store.setState({ projectName: schema.readProjectName(ydoc) ?? 'Shared project' })
    readName()
    schema.metaMap(ydoc).observe((e) => {
      if (e.keysChanged.has(schema.PROJECT_NAME_META)) readName()
    })
  }
  if (own && !resolved.view) {
    if (!own.demo) startWriteBack(store, own)
    const line = {
      send: (payload: string) => provider.sendStateless(payload),
      listen: (cb: (payload: string) => void) => {
        const on = ({ payload }: { payload: string }): void => cb(payload)
        provider.on('stateless', on)
        return () => provider.off('stateless', on)
      },
    }
    // claimed again on every sync: a reconnect is a new connection, and the server knows the owner by it
    const claim = (): void => claimRoom(ownSharedProject() ?? own, line, ydoc.clientID)
    claim()
    provider.on('synced', ({ state }: { state: boolean }) => {
      if (state) claim()
    })
  }
}

function mount(): void {
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('hook')) {
    const hook = (window.__oip ??= {})
    // getPartThumbnails + getBundledThumbnails are exposed for the offline thumbnail generator (npm run
    // thumbnails): the first bakes the built-in cards, the second the first-party bundled custom-part cards
    // (rendered through the same offscreen factory, keyed by package id). Bundled packages are loaded +
    // registered in the viewport effect (loadBundledExamples), so the generator waits for them before calling.
    const getBundledThumbnails = async (): Promise<[string, string][]> =>
      [...(await renderPackageThumbnails(store.getState().bundledPackages)).entries()]
    // ...and getSourceThumbnails renders part sources that are no built-in (a first-party library's, libraries/<lib>/<part>:
    // npm run thumbnails -- --libraries). Built here, so the generator needs no second bake.
    const getSourceThumbnails = async (sources: { manifest: PackageManifest; behavior: string }[]): Promise<[string, string][]> => {
      const { buildPackage } = await import('../sim/buildPackage')
      const pkgs = sources.map((x) => buildPackage(x.manifest, x.behavior))
      for (const p of pkgs) registerPackage(p)
      return [...(await renderPackageThumbnails(pkgs)).entries()]
    }
    // sceneFileText / importSceneText are the scene-file writer and Import Project's scene-file path, exposed so a gate
    // can prove the round trip end to end (a scene file re-opens and runs) without driving a file dialog;
    // loadSceneText is the fixture loader (it replaces the active scene, which no UI surface does)
    Object.assign(hook, {
      store,
      sim,
      getPartThumbnails,
      getBundledThumbnails,
      getSourceThumbnails,
      getPackage,
      registerPackage,
      speculativeFetches,
      sceneFileText: () => sceneFileText(store.getState()),
      // the controller is read at call time: App publishes it on the hook once the viewport mounts
      importSceneText: (text: string, fileName: string) => importSceneText(store, text, fileName, hook.controller),
      loadSceneText: (text: string) => loadSceneText(store, text),
    })
  }

  // Wrapped so a render/lifecycle throw shows the crash dialog (components/CrashDialog.tsx)
  // instead of unmounting the editor to a blank page with the document still only in localStorage.
  createRoot(document.getElementById('root')!).render(
    <AppCrashBoundary store={store}>
      <App store={store} sim={sim} />
    </AppCrashBoundary>,
  )

  // The sim worker (Jolt, ~3.5 MB) is spawned lazily so it doesn't compete with the
  // building/viewport on first load. Prewarm it once the page is idle, so the first
  // Play is still instant.
  const prewarm = (): void => sim.prewarm()
  if ('requestIdleCallback' in window) requestIdleCallback(prewarm, { timeout: 3000 })
  else setTimeout(prewarm, 2000)

  // Warm the catalog thumbnails (~80 KB total) on a short idle so switching the
  // Parts tabs is instant; otherwise each tab's <img> fetches only on first click
  // (inactive-tab cards aren't mounted). Cheap and visible, so it runs before the
  // heavier model warm.
  //
  // The bundled packages are the catalog, so their ids go in explicitly: PART_DEFS on its own
  // holds only `building` (see prefetchThumbnails). Manifests, not built packages: these are the
  // eager-globbed rig.json objects, available here at mount, whereas the built+registered packages
  // only exist after App's viewport effect runs loadBundledExamples, too late to warm anything.
  const warmThumbs = (): void => prefetchThumbnails(bundledThumbnailIds())
  if ('requestIdleCallback' in window) requestIdleCallback(warmThumbs, { timeout: 2000 })
  else setTimeout(warmThumbs, 1000)

  // The heavy part-model warm is a registry-derived sweep of the whole catalog through warmPart
  // (App.tsx → controller.warmCatalog), started after the view mounts and the scene paints. It is derived
  // from the registry because a hand-maintained list drifts and skips parts. Nothing to schedule here; the
  // thumbnail warm above runs here because it needs no view/controller.
}

const params = new URLSearchParams(location.search)
// A link for a display (Share > Can view > For a display) opens with only the scene, locked: a visitor may move the
// camera but not act on the design, so no key reaches the editor but the flight keys while they fly (right button held),
// and there is no way out but the browser's own. This listener is added before the app mounts, so it runs ahead of every
// key listener the app adds.
if (params.get('present') === '1') {
  store.setState({ presenting: true, presentLocked: true })
  const block = (e: KeyboardEvent): void => {
    const { presentLocked, navigating } = store.getState()
    // the values list's filter takes typing (components/PresentValues.tsx)
    if (e.target instanceof Element && e.target.closest('.present-values-filter')) return
    if (presentLocked && !(navigating && !e.ctrlKey && !e.metaKey && !e.altKey)) e.stopImmediatePropagation()
  }
  window.addEventListener('keydown', block, true)
  window.addEventListener('keyup', block, true)
}

/**
 * ?xremu: install an emulated WebXR runtime + on-page headset/controller controls
 * (IWER + its DevUI) so the VR walkthrough can be driven with mouse/keyboard - no
 * headset, no browser extension, no vendor account. Must resolve before mount():
 * the toolbar's vrSupported() probe runs when it mounts, and IWER can only take
 * over navigator.xr before anything queries it. Dev-only: the DEV gate lets the
 * prod build drop the emulator chunks entirely (they'd otherwise end up in the PWA
 * precache for every user); E2E injects IWER itself via addInitScript instead.
 */
async function installXREmulator(): Promise<void> {
  if (!import.meta.env.DEV || !params.has('xremu')) return
  try {
    const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([import('iwer'), import('@iwer/devui')])
    const device = new XRDevice(metaQuest3)
    // forceInstall: Chrome and Edge ship a native navigator.xr, which IWER otherwise steps aside for,
    // and ?xremu on a desktop with no headset then emulated nothing
    device.installRuntime({ forceInstall: true })
    // standing height before DevUI installs: its input layer snapshots the device pose
    // as the rig default and re-syncs it every frame, so a floor-level start sticks
    device.position.set(0, 1.7, 0)
    device.installDevUI(DevUI)
    // drivable from the console / E2E alongside the other dev hooks
    ;(window.__oip ??= {}).xrDevice = device
  } catch (err) {
    console.warn('[oip] WebXR emulator (?xremu) failed to load', err)
  }
}

const xremu = installXREmulator()

function startSolo(): void {
  // Share from this tab enters the room it mints without a reload (Toolbar copyShareLink, toggleLive). The solo saves
  // stand down by themselves once the store is in collab mode (store persist, the library, the folder sync).
  registerRoomEntry(async (roomUrl, seed) => {
    const url = new URL(roomUrl)
    const resolved = await resolveRoom(url.searchParams.get('room') ?? '')
    if (!resolved) return
    for (const p of ['scene', 'view', 'handoff']) url.searchParams.delete(p)
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    // Held read-only until the room's document has synced and its bridge is up: an edit made in between would land in
    // a store the room's document then replaces, and be lost. (A newer build's claim, met while booting, keeps it so.)
    store.setReadOnly(true)
    try {
      await bootRoom(resolved, seed)
    } finally {
      if (!store.getState().roomNewerBuild) store.setReadOnly(false)
    }
  })
  watchOtherTabs()
  const boot = (): void => {
    bootSolo()
    // an older multi-scene project's other scenes, parked by the boot: filed now (projectSplit.ts); the folder sync
    // waits for it (App.tsx)
    startSplitFiling(store)
    // The scene is in the store now; its parts' GLBs/textures need not wait for the renderer
    // handshake + React mount that emits them today (~2.6 s of idle link under WebGPU).
    prefetchSceneAssets(store.getState().scene)
    void xremu.then(mount).catch((e: unknown) => console.error('[oip] the editor failed to mount', e))
  }
  // the working copy is the open document's library row, read before the boot (projectFile.openWorkingCopy)
  void openWorkingCopy()
    .catch(() => {})
    .then(boot)
    .catch((e: unknown) => console.error('[oip] the editor failed to boot', e))
  keepWorkingCopySmall()
}

/**
 * A model added this session is written embedded until its bytes are in the asset store (localAssets.ts). Save again
 * once they are, so the working copy names it by hash rather than carrying its bytes on every save. Then delete
 * stored models nothing names any more, once the boot is done with the database.
 */
function keepWorkingCopySmall(): void {
  onLocalAssetsStored(() => {
    const s = store.getState()
    // persistProject would fork a demo preview into a project, and the other states write no working copy
    if (s.collab || s.demoSession || s.readOnly || s.unopenedProject) return
    store.persistProject()
  })
  // a save returns before its row is written (projectFile.saveStoredProject), so a failed write raises the banner here
  onWorkingCopyWrite((result) => {
    const next = result.ok ? null : result.message
    if (store.getState().autosaveError !== next) store.setState({ autosaveError: next })
  })
  if (supportsLocalAssets()) {
    setTimeout(
      () =>
        void storedAssetTexts()
          .then((texts) => texts && sweepLocalAssets(texts))
          .catch((e: unknown) => console.warn('[oip] sweeping stored model assets failed', e)),
      30_000,
    )
  }
}

/**
 * The room to open: the link's, or, when the project this browser has open is one of its own that it shared, that
 * project's room (project/sharedProject.ts), since a shared project is edited in its room. The demo and a desktop
 * hand-over are not the open project, so they open as they are.
 */
function roomToOpen(): string | null {
  const linked = params.get('room')
  if (linked !== null || params.has('handoff')) return linked
  // the demo this browser shared opens in its room too, until its sharer stops sharing it there
  const shared = params.get('scene') === 'demo' ? sharedDemo() : params.has('scene') ? null : sharedProjectOf(currentDocumentId())
  if (!shared) return null
  const url = new URL(location.href)
  url.searchParams.delete('scene')
  url.searchParams.set('room', shared.room)
  if (shared.server) url.searchParams.set('server', shared.server)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  return shared.room
}

const room = roomToOpen()
if (room) {
  void resolveRoom(room).then((resolved) => {
    // the owner of a shared project seeds its room again if the server lost it (seedIfEmpty does nothing otherwise),
    // from the project it keeps in step (project/sharedProject.ts), when that is the project this browser has open
    const own = ownSharedProject()
    const seed = own && !own.demo && own.docId === currentDocumentId() ? 'scene' : null
    // gate render on first sync so we don't flash an empty scene before remote state loads
    // the working copy is read first: a room is seeded from it (soloDocOrDefault) and written back to it
    if (resolved) {
      return void Promise.all([openWorkingCopy().catch(() => {}).then(() => bootRoom(resolved, seed)), xremu])
        .finally(mount)
        .catch((e: unknown) => console.error('[oip] joining the shared project failed', e))
    }
    // Not a room link (an unprefixed id from before edit secrets, or a garbled one): open solo and
    // say so, with the room taken out of the address bar so Share and a reload treat this tab as solo.
    const url = new URL(location.href)
    url.searchParams.delete('room')
    url.searchParams.delete('view')
    url.searchParams.delete('server')
    history.replaceState(history.state, '', url)
    startSolo()
    store.showSaveNotice(
      'Share link not recognized',
      'This link does not name a shared project, so the editor opened on its own. Ask whoever sent it for a new link from Share.',
    )
  }).catch((e: unknown) => console.error('[oip] opening the shared project failed', e))
} else {
  startSolo()
  // sent back from a room its owner closed (bootRoom leaveClosed)
  if (params.has('closed')) {
    const url = new URL(location.href)
    url.searchParams.delete('closed')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    store.showSaveNotice('That shared project was closed', 'Its owner stopped sharing it, so its links no longer open it. Ask them to share it again.')
  }
  // the desktop app booted to take a browser's project (Open in Desktop App; desktopHandoff.ts asks before importing)
  const handoff = DESKTOP_SHELL ? params.get('handoff') : null
  if (handoff) {
    void import('./desktop/desktopHandoff')
      .then((m) => m.receiveDesktopHandoff(store, handoff))
      .catch((e: unknown) => console.warn('[oip] taking the browser project failed', e))
  }
}
