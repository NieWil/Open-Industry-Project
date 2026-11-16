import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PresenceStack } from './PresenceStack'
import { DEMO_SCENE_NAME } from '../demo/demoScenes'
import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { getCollabSnapshot, getPeers, subscribeCollab } from '../../collab/session'
import { docNameForSecret, EDIT_PREFIX, markRoomForSeed, mintEditSecret, type SeedKind } from '../../collab/rooms'
import { enterRoomInPlace } from '../roomEntry'
import { mintOwnerToken, noteSharedProject, ownSharedProject, setSpotlight, stopSharing } from '../project/sharedProject'
import { currentDocumentId } from '../project/documentStore'
import { collabUrl, onOtherCollabServer, SERVER_PARAM, shareableLink } from '../../collab/collabServer'
import { keymapRev, subscribeKeymap } from '../../core/keymap'
import { commandChord, commandEnabled, getCommand, runCommand, SIM_SPEEDS } from '../commands'
import { DESKTOP_MAC, DESKTOP_SHELL, getOipMenuApi } from '../desktop/desktopMenuBridge'
import { keyHint, withKey } from '../keyHint'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { ForcesStatus } from './plc/ForcesStatus'
import { PlcLinkStatus } from './plc/PlcLinkStatus'
import { ProjectMenu } from './ProjectMenu'
import { focusFirstMenuItem, fromKeyboard, menuKeys, useDismiss } from './popover'
import {
  ChevronIcon,
  DistractionFreeIcon,
  ExternalLinkIcon,
  EyeIcon,
  DisplayIcon,
  GitHubIcon,
  HelpIcon,
  OverflowIcon,
  PauseIcon,
  PencilIcon,
  PilotIcon,
  PlayIcon,
  SettingsIcon,
  ShareIcon,
  StopIcon,
  VRIcon,
} from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'
import { displayedValues } from '../program/displayValues'

const M = defineMessages('toolbar', {
  menuTitle: 'Menu (Alt)',
  menu: 'Menu',
  withChord: '{label} ({chord})',
  pausedHint: 'Already running (paused). Use Pause to resume',
  runningHint: 'Running. Use Stop to end the run',
  runPart: 'Run this part on its own',
  startSimTitle: 'Start Simulation',
  startSim: 'Start Simulation',
  resumeSimTitle: 'Resume Simulation (currently paused)',
  pauseSimTitle: 'Pause Simulation',
  resumeSim: 'Resume Simulation',
  pauseSim: 'Pause Simulation',
  stopSimTitle: 'Stop Simulation',
  stopSim: 'Stop Simulation',
  speedShortTitle:
    "Simulation Speed: {requested}× requested, ~{actual}× actual. This machine can't step the world any faster, so the sim advances slower than {requested}× real time (its own timing stays exact).",
  speedTitle: 'Simulation Speed: click to cycle 0.5×, 1×, 2×, 4×, 8× (Shift+click to step back)',
  speedPlcClockTitle:
    'Simulation Speed: {speed}×. The external PLC runs in real time, so away from 1× its timers and reaction times no longer match the simulation and the line can behave differently. Click to cycle (Shift+click to step back)',
  speedShortAria: 'Simulation is advancing at about {rate} times real time. Why?',
  speedNote: 'Simulation speed',
  runningAt: 'Running at ~{rate}× real time',
  runningAtRequested: 'Running at ~{rate}× real time ({requested}× requested)',
  deviceSlow: 'This device cannot step the world any faster, so the simulation advances slower than the clock on the wall.',
  timingExact: 'Its own timing stays exact: a 2 s timer is still 2 s of simulated time, it just takes longer to watch.',
  readOnlyTitle: 'You opened a read-only link. Watch and run the simulation, but editing is disabled',
  viewOnly: 'View only',
  watchers: { one: '{count} watching', other: '{count} watching' },
  watchersTitle: 'People watching your run as it happens.',
  spotlight: 'Spotlight',
  spotlightTitle: 'Ask everyone here to watch your run. They can stop watching at any time.',
  spotlightOn: { one: 'Spotlight · {count} watching', other: 'Spotlight · {count} watching' },
  spotlightOnTitle: 'Everyone here is asked to watch your run.',
  stopSpotlight: 'Stop',
  stopSpotlightTitle: 'Stop the spotlight: everyone goes back to what they were doing',
  waitingFor: 'Waiting for {name} to run',
  waitingForTitle: 'Their next run shows here as it happens.',
  watchShort: 'Watch',
  watching: 'Watching {name}',
  watchingSpotlight: 'Watching {name} (spotlight)',
  watchingTitle: "You are watching {name}'s run as it happens. Start Simulation runs your own copy instead.",
  stopWatching: 'Stop watching',
  followView: 'Follow view',
  followViewTitle: "You moved your own view. Go back to following {name}'s.",
  offerWatch: '{name} is running · Watch',
  offerWatchTitle: "Watch {name}'s run as it happens. Your own work is not touched.",
  offerMany: { one: '{count} running · Watch', other: '{count} running · Watch' },
  offerManyTitle: 'Choose whose run to watch',
  someone: 'Someone',
  runOwnCopy: 'Run my own copy (stops watching)',
  stopSharing: 'Stop sharing',
  stopSharingSub: 'Work on {name} alone again. Links you gave out stop working.',
  stopSharingDemoSub: 'Back to the example on your own. Links you gave out stop working.',
  stopSharingRunning: 'Stop the simulation first',
  moreActions: 'More actions',
  speedItem: 'Speed: {speed}×',
  speedItemShort: 'Speed: {speed}× (~{actual}× actual)',
  shareLive: 'Share this project',
  startShare: 'Share this project',
  startLive: 'Share this project',
  share: 'Share',
  canEdit: 'Can edit',
  canEditSub: 'Anyone with the link can build and run',
  copy: 'Copy',
  canView: 'Can view',
  canViewSub: 'Anyone with the link can watch, not edit',
  viewLinkCopied: 'View link copied',
  forDisplay: 'For a display',
  forDisplaySub: 'Full screen and locked, following your run and view',
  forDisplaySubOther: 'Full screen and locked, following the owner',
  forDisplayTitle: 'For a screen nobody uses: only the scene, and it cannot be left from inside the app. Close the browser to leave it.',
  displayValues: { one: '{count} PLC value shown · Preview and edit…', other: '{count} PLC values shown · Preview and edit…' },
  displayValuesNone: 'Add PLC values · Preview and edit…',
  displayValuesTitle: 'See the display as it shows, in your own window, and choose the PLC values listed beside the scene',
  displayLinkCopied: 'Display link copied',
  sharedNow: 'This project is now shared: people you invite edit it with you.',
  undoStartsOver: 'Sharing starts a new undo history. Changes made before it cannot be undone.',
  linkCopiedShared: 'Link copied. This project is now shared.',
  startingRoom: 'Sharing…',
  inviteLinkCopied: 'Invite link copied',
  copyFailed: 'Copy failed',
  pilotTitle: '{label}: first-person walk-around; {exit} to exit',
  pilotMode: 'Pilot Mode',
  vrTitle:
    'VR Mode: walk the factory in a headset. Left stick walks, right stick turns, trigger uses; exit from the headset menu or click again',
  vrMode: 'VR Mode',
  distractionFreeTitle: '{label}: Shift+Click also toggles browser fullscreen',
  distractionFree: 'Distraction Free Mode',
  settings: 'Settings',
  helpTitle: 'Help: keyboard shortcuts, the tutorial, and the project on GitHub',
  help: 'Help',
  tutorialTitle: 'Opens in a project of its own. The one you are in is kept',
  openDesktopRoom: 'Opens this shared project in the desktop app',
  openDesktopCopy: 'Opens a copy of this project in the desktop app; this browser keeps its own',
  github: 'Open Industry Project on GitHub',
})

/** a command's label, through the seam (commands.ts) */
const commandLabel = (id: string): string => getCommand(id)?.label ?? id

// Windows/Linux desktop only: the shell hides the OS menu bar to save a row of height (main.cjs TITLE_BAR), so
// the toolbar's mark is the pointer path to the menu - it pops the real native Menu, not a copy of it.
// macOS never gets one: its menu lives in the screen's menu bar, where the OS owns the whole interaction.
function openAppMenu(e: MouseEvent<HTMLButtonElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  getOipMenuApi()?.showAppMenu?.(Math.round(r.left), Math.round(r.bottom))
}

// The file and scene actions are not in this row: they are the project menu's (ProjectMenu.tsx), behind the
// project's name - and the scene's, once there is one to choose - at the left.

/** `label (chord)` for a transport button: F5 and friends in the desktop app, the app's own chord in the browser */
function withCommandKey(label: string, id: string): string {
  const cmd = getCommand(id)
  const chord = cmd ? commandChord(cmd) : ''
  return chord ? t(M.withChord, { label, chord }) : label
}

const GITHUB_URL = 'https://github.com/Open-Industry-Project/Open-Industry-Project'

interface ToolbarProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
}

export function Toolbar({ store, state, controller }: ToolbarProps) {
  const [shareLabel, setShareLabel] = useState<MessageId | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  // entering a room in place holds the editor read-only for a moment (main.tsx registerRoomEntry), which is not view-only
  const [entering, setEntering] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)
  const shareButtonRef = useRef<HTMLButtonElement>(null)
  // WebXR walkthrough: the button only renders when an immersive-vr runtime exists
  // (a headset browser, or an emulated device via IWER / the Immersive Web Emulator)
  const [vrSupported, setVrSupported] = useState(false)
  const [vrActive, setVrActive] = useState(false)
  useEffect(() => {
    let stale = false
    void controller
      ?.vrSupported()
      .then((ok) => {
        if (!stale) setVrSupported(ok)
      })
      .catch((e: unknown) => console.warn('[oip] checking for VR failed', e))
    return () => {
      stale = true
    }
  }, [controller])
  // the "⋯" overflow: the file actions once the row is too narrow for them (and, on a phone, sim speed)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuListRef = useRef<HTMLDivElement>(null)
  // Help: the keyboard reference, the tour and the project's home, behind one button. They were three
  // icon buttons in the same chrome as the mode toggles beside them, so the link that LEAVES the app
  // looked exactly like one more toggle, and together they cost the row ~80px it measurably lacks.
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)
  const helpButtonRef = useRef<HTMLButtonElement>(null)
  const helpListRef = useRef<HTMLDivElement>(null)
  // phone-only: the shortfall badge's explanation panel (the badge itself lives in .toolbar-run)
  const [speedNoteOpen, setSpeedNoteOpen] = useState(false)
  const speedNoteRef = useRef<HTMLDivElement>(null)
  const collab = useSyncExternalStore(subscribeCollab, getCollabSnapshot)
  // the tooltips below print chords from the ACTIVE keymap, so a rebinding in Settings has to re-render them
  useSyncExternalStore(subscribeKeymap, keymapRev)

  const closeShare = () => {
    setShareOpen(false)
    setShareLabel(null)
  }
  const closeMenu = () => setMenuOpen(false)
  const closeHelp = () => setHelpOpen(false)
  useDismiss(shareRef, closeShare, { active: shareOpen, trigger: shareButtonRef })
  useDismiss(menuRef, closeMenu, { active: menuOpen, trigger: menuButtonRef })
  useDismiss(helpRef, closeHelp, { active: helpOpen, trigger: helpButtonRef })
  useDismiss(speedNoteRef, () => setSpeedNoteOpen(false), { active: speedNoteOpen })

  // A menu opened from the KEYBOARD is the one the arrow keys then drive, so focus moves into it. Opened by
  // a click or a tap it stays where it was (popover.ts fromKeyboard).
  const menuByKey = useRef(false)
  const helpByKey = useRef(false)
  useEffect(() => {
    if (menuOpen && menuByKey.current) focusFirstMenuItem(menuListRef.current)
  }, [menuOpen])
  useEffect(() => {
    if (helpOpen && helpByKey.current) focusFirstMenuItem(helpListRef.current)
  }, [helpOpen])

  // This tab's room link. A solo tab mints a room, and its document seeds it: the untouched demo goes in as THE demo,
  // which stays current until someone edits it (collab/demoRoom.ts), with nothing flushed (an autosave would fork the
  // demo into the user's own scenes for no reason of theirs); anything else is flushed first, so the seed is what is on
  // screen.
  const roomLink = (): { url: URL; room: string; mint: SeedKind | null } => {
    const url = new URL(location.href)
    let room = url.searchParams.get('room')
    let mint: SeedKind | null = null
    if (!room) {
      room = mintEditSecret()
      url.searchParams.set('room', room)
      mint = store.getState().demoSession ? 'demo' : 'scene'
      if (mint === 'scene') store.flushAutosave()
    }
    // a room on a server other than the build's: the link has to say which (collab/provider.ts collabUrl)
    if (onOtherCollabServer()) url.searchParams.set(SERVER_PARAM, collabUrl())
    return { url, room, mint }
  }

  // Take this solo tab into the room it just minted: in place, with no reload (editor/roomEntry.ts). Where this surface
  // cannot, it reloads into the room, leaving the seed mark the room boot reads (rooms.ts: only the minting tab seeds).
  // True when it entered in place.
  const enterRoom = async (url: URL, room: string, mint: SeedKind): Promise<boolean> => {
    // a project of the user's own, shared, stays their project (project/sharedProject.ts)
    // ...and the demo, shared, is owned by whoever shared it, though it is no project of theirs (sharedProject.ts `demo`)
    const server = onOtherCollabServer() ? collabUrl() : null
    if (mint === 'scene') noteSharedProject({ docId: currentDocumentId(), room, project: store.getState().projectName, server, ownerToken: mintOwnerToken() })
    else noteSharedProject({ docId: null, room, project: DEMO_SCENE_NAME, server, ownerToken: mintOwnerToken(), demo: true })
    setEntering(true)
    const inPlace = await enterRoomInPlace(url.toString(), mint).finally(() => setEntering(false))
    if (inPlace) return true
    markRoomForSeed(room, mint)
    location.assign(url.toString())
    return false
  }

  // Copy an invite link from the Share popover. 'edit' = the room's edit secret
  // (?room=e-…); 'view' = the derived doc name (?room=r-…), which holds no secret, so the
  // server refuses writes from it, so view-only is enforced there, not only in the UI (rooms.ts
  // has the scheme). A solo tab enters the room it mints (enterRoom), and the seeded room is what makes a view link
  // resolve to a populated scene rather than an empty one. (`&view=1` on a view link only labels it:
  // the r- doc name alone is what makes it view-only.)
  const copyShareLink = async (mode: 'edit' | 'view' | 'display') => {
    const { url, room, mint } = roomLink()
    // the host's own tab always lands in edit mode; only the copied link is demoted
    const linkToCopy = new URL(url.toString())
    // a link names the shared project, not how this tab was opened (the demo's ?scene=demo, a display's &present=1)
    for (const entry of ['scene', 'present']) linkToCopy.searchParams.delete(entry)
    if (mode !== 'edit') {
      if (room.startsWith(EDIT_PREFIX)) linkToCopy.searchParams.set('room', await docNameForSecret(room))
      linkToCopy.searchParams.set('view', '1')
    }
    // a display opens with only the scene (components/PresentOverlay.tsx); it follows the owner like any view link
    if (mode === 'display') linkToCopy.searchParams.set('present', '1')
    try {
      await navigator.clipboard?.writeText(shareableLink(linkToCopy).toString())
      setShareLabel(mint === 'scene' ? M.linkCopiedShared : mode === 'view' ? M.viewLinkCopied : mode === 'display' ? M.displayLinkCopied : M.inviteLinkCopied)
    } catch {
      setShareLabel(M.copyFailed)
    }
    setTimeout(() => setShareLabel(null), 2000)
    // the link is on the clipboard first, while the click still counts as the gesture a clipboard write needs
    if (mint && !(await enterRoom(url, room, mint))) return
    setTimeout(() => setShareOpen(false), 600)
  }


  const stopSharingProject = async () => {
    const shared = ownSharedProject()
    const error = shared ? await stopSharing(store, shared) : null
    if (error !== null) alert(error)
  }

  // The CYCLE over the shared ladder (SIM_SPEEDS in editor/commands.ts, which also exposes each rung
  // as its own command for the menu and the palette). Click walks up and wraps 8x back to 0.5x;
  // Shift walks it back down, which is what keeps five rungs usable from one 40px control.
  const cycleSpeed = (e?: { shiftKey: boolean }) => {
    const i = SIM_SPEEDS.indexOf(state.timeScale as (typeof SIM_SPEEDS)[number])
    const next = (i + (e?.shiftKey ? SIM_SPEEDS.length - 1 : 1)) % SIM_SPEEDS.length
    controller?.setTimeScale(SIM_SPEEDS[next] ?? 1)
  }

  // The worker sheds backlog when it can't hold the requested speed, so the button's number can
  // overstate what is happening; state.speedActual is the measured rate when it does (null when
  // it's keeping up). Sim results stay exact either way - only wall-clock progress falls short.
  const speedShort = state.speedActual !== null
  // A real PLC scans on its own clock, so off 1x its timers and reactions drift from the sim's. Allowed (filling a
  // buffer fast, watching a handoff slowly), but flagged; Play itself resets to 1x (plcLinks.ts attachExternalPlc).
  const plcClock = state.running && state.timeScale !== 1 && state.externalPlc.enabled && (controller?.externalPlcAvailable ?? false)
  const speedTitle = plcClock
    ? t(M.speedPlcClockTitle, { speed: state.timeScale })
    : speedShort
      ? t(M.speedShortTitle, { requested: state.timeScale, actual: state.speedActual ?? 0 })
      : t(M.speedTitle)

  // A shortfall that clears unmounts the badge; reopening later should start closed rather than
  // restoring a panel the user dismissed by the machine catching up.
  useEffect(() => {
    if (!speedShort) setSpeedNoteOpen(false)
  }, [speedShort])

  const shortcutsKey = keyHint('ui.shortcuts')
  const paletteKey = keyHint('ui.commands')
  const tutorialCmd = getCommand('help.tutorial')

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {/* The mark alone, no wordmark: the tab already names the app ("<project> - Open Industry Project",
            App.tsx), and a bold app name beside the bold project name read as two titles competing for the
            corner. Narrow windows, phones and the desktop shell never had the wordmark either, so this
            makes every surface match. The desktop shell hid the OS title bar to win back a row, so there
            the mark doubles as the menu button, the way a Windows app with no menu bar puts its
            icon top-left; macOS keeps its screen menu bar, so it shows nothing at all. The img is
            decorative. oip-icon.svg is the mark as true vector; the old oip-mark.svg was a TRACED 16px
            bitmap, so at the 24px this renders at it was an upscale of a blurry downscale. */}
        {!DESKTOP_SHELL && <img className="toolbar-logo" src="/oip-icon.svg" alt="" aria-hidden="true" />}
        {/* The caret is the project menu's own: a bare mark read as branding, and people did not find the
            menu behind it. Menu names in the row were measured instead: the six take 300px
            and only fit at 1520px and up, a width most laptops never reach at their usual display scaling. */}
        {DESKTOP_SHELL && !DESKTOP_MAC && (
          <button
            type="button"
            className="toolbar-menu-btn"
            data-tutorial="app-menu"
            title={t(M.menuTitle)}
            aria-label={t(M.menu)}
            aria-haspopup="menu"
            onClick={openAppMenu}
          >
            <img className="toolbar-logo" src="/oip-icon.svg" alt="" aria-hidden="true" />
            <ChevronIcon dir="down" size={12} />
          </button>
        )}
        <ProjectMenu store={store} state={state} />
      </div>
      <div className="toolbar-run">
        <LiveControl collab={collab} store={store} state={state} openPeople={() => setPeopleOpen(true)} />
        <div className="run-transport segmented" role="group">
          <button
            className={`run-button play${state.running ? ' running' : ''}${state.liveFollowing ? ' watching' : ''}`}
            data-tutorial="play"
            // Paused is the case worth naming: the run is still going, so this stays disabled, and the
            // instinct is to reach HERE to resume rather than back to Pause. Say where the resume is
            // instead of leaving a dead button offering to "Start Simulation".
            title={
              state.paused
                ? t(M.pausedHint)
                : state.running
                  ? t(M.runningHint)
                  : state.liveFollowing
                  ? t(M.runOwnCopy)
                  : state.focusedPartId !== null
                  ? t(M.runPart)
                  : withCommandKey(t(M.startSimTitle), 'sim.run')
            }
            aria-label={t(M.startSim)}
            disabled={!controller || state.running}
            onClick={() => controller?.run()}
          >
            <PlayIcon />
          </button>
          <button
            className={`run-button pause${state.paused ? ' active' : ''}`}
            // This button IS the resume, because Play stays disabled for the whole run. So while
            // paused it has to SAY so: a fixed
            // "Toggle Pause" left the highlight as the only clue the run was held, and left a
            // screen reader with none at all - hence aria-pressed, which the two toggles beside
            // it in this row already carry.
            title={withCommandKey(t(state.paused ? M.resumeSimTitle : M.pauseSimTitle), 'sim.pause')}
            aria-label={t(state.paused ? M.resumeSim : M.pauseSim)}
            aria-pressed={state.paused}
            disabled={!controller || !state.running}
            onClick={() => controller?.togglePause()}
          >
            <PauseIcon />
          </button>
          <button
            className="run-button stop"
            data-tutorial="stop"
            title={withCommandKey(t(M.stopSimTitle), 'sim.stop')}
            aria-label={t(M.stopSim)}
            disabled={!controller || !state.running}
            onClick={() => controller?.stop()}
          >
            <StopIcon />
          </button>
        </div>
        <button
          className={`run-button speed${state.timeScale !== 1 ? ' boosted' : ''}${speedShort ? ' short' : ''}${plcClock ? ' plc-clock' : ''}`}
          data-testid="sim-speed"
          title={speedTitle}
          disabled={!controller}
          onClick={cycleSpeed}
        >
          {state.timeScale}×{speedShort && <span className="speed-actual">~{state.speedActual}×</span>}
        </button>
        {/* Phone twin of that button's shortfall readout. On a phone the speed button is dropped
            from the bar (CSS) and a `title` is unreachable by touch, so the device MOST likely to
            fall short of real time was the one saying nothing about it. Tapping opens the reason as
            TEXT. What it must convey: nothing is wrong with the run - physics and the interleaved
            PLC scan shed backlog TOGETHER (sim/worker.ts, sim/plcHost.ts), so sim time and every
            timer on it stay exact; it is wall-clock progress that falls short. Hidden on desktop
            and tablet (CSS), where the button carries the same reading. */}
        {speedShort && (
          <div className="speed-short-badge" ref={speedNoteRef}>
            <button
              type="button"
              className={`speed-short-button${speedNoteOpen ? ' active' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={speedNoteOpen}
              aria-label={t(M.speedShortAria, { rate: state.speedActual ?? 0 })}
              onClick={() => setSpeedNoteOpen((v) => !v)}
            >
              ⚠ <span className="speed-short-rate">~{state.speedActual}×</span>
            </button>
            {speedNoteOpen && (
              <div className="speed-short-note" role="dialog" aria-label={t(M.speedNote)}>
                <strong>
                  {state.timeScale !== 1
                    ? t(M.runningAtRequested, { rate: state.speedActual ?? 0, requested: state.timeScale })
                    : t(M.runningAt, { rate: state.speedActual ?? 0 })}
                </strong>
                <span>{t(M.deviceSlow)}</span>
                <span>{t(M.timingExact)}</span>
              </div>
            )}
          </div>
        )}
        {/* while Play hands the scene to an external PLC: the link's state, where a vendor tool shows it is online */}
        {controller && <PlcLinkStatus state={state} controller={controller} />}
        {/* while the running program has forced variables: how many, and the way to release them */}
        {controller && <ForcesStatus controller={controller} state={state} />}
      </div>
      <div className="toolbar-right">
        <PresenceStack store={store} state={state} open={peopleOpen} setOpen={setPeopleOpen} />
        {state.readOnly && !entering && (
          <span className="collab-viewonly" title={t(M.readOnlyTitle)}>
            {t(M.viewOnly)}
          </span>
        )}
        {/* The overflow: a phone's sim speed, which it drops from the bar (CSS shows this only there). The file
            actions are the project menu's on every layout, phones included. */}
        <div className="toolbar-overflow" ref={menuRef}>
          <button
            ref={menuButtonRef}
            className={`overflow-button${menuOpen ? ' active' : ''}`}
            title={t(M.moreActions)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t(M.moreActions)}
            onClick={(e) => {
              menuByKey.current = fromKeyboard(e)
              setMenuOpen((v) => !v)
            }}
          >
            <OverflowIcon />
          </button>
          {menuOpen && (
            <div className="overflow-popover" role="menu" aria-label={t(M.moreActions)} ref={menuListRef} onKeyDown={menuKeys(closeMenu)}>
              {/* phone-only (CSS): the speed button is dropped from the bar there. This
                  leaves the menu open so repeated taps cycle 0.5× → 1× → 2× → 4× → 8×. */}
              <button
                className="overflow-item overflow-speed"
                role="menuitem"
                title={speedTitle}
                disabled={!controller}
                onClick={cycleSpeed}
              >
                {speedShort
                  ? t(M.speedItemShort, { speed: state.timeScale, actual: state.speedActual ?? 0 })
                  : t(M.speedItem, { speed: state.timeScale })}
              </button>
            </div>
          )}
        </div>
        {!state.readOnly && (
          <div className="share-wrap" ref={shareRef}>
            <button
              ref={shareButtonRef}
              className={`share-button${shareOpen ? ' active' : ''}`}
              title={t(collab.room ? M.shareLive : M.startShare)}
              aria-haspopup="dialog"
              aria-expanded={shareOpen}
              onClick={() => setShareOpen((v) => !v)}
            >
              <ShareIcon />
              {/* label drops on a phone (CSS) - the glyph carries it there */}
              <span className="share-label">{t(M.share)}</span>
            </button>
            {/* A dialog, not a menu: it holds a text field and a status line, and a role="menu" promises
                arrow-key item navigation that a name field cannot take part in. */}
            {shareOpen && (
              <div
                className="share-popover"
                role="dialog"
                aria-label={t(collab.room ? M.shareLive : M.startLive)}
              >
                <div className="share-popover-head">{t(collab.room ? M.shareLive : M.startLive)}</div>
                <button className="share-option" onClick={() => void copyShareLink('edit')}>
                  <span className="share-option-icon">
                    <PencilIcon />
                  </span>
                  <span className="share-option-text">
                    <span className="share-option-label">{t(M.canEdit)}</span>
                    <span className="share-option-sub">{t(M.canEditSub)}</span>
                  </span>
                  <span className="share-option-copy">{t(M.copy)}</span>
                </button>
                <button className="share-option" onClick={() => void copyShareLink('view')}>
                  <span className="share-option-icon">
                    <EyeIcon />
                  </span>
                  <span className="share-option-text">
                    <span className="share-option-label">{t(M.canView)}</span>
                    <span className="share-option-sub">{t(M.canViewSub)}</span>
                  </span>
                  <span className="share-option-copy">{t(M.copy)}</span>
                </button>
                {/* the same view-only access, opened locked in Present (main.tsx): a way to start Can view, not a third level */}
                <button className="share-option share-sub-option" data-testid="share-display" title={t(M.forDisplayTitle)} onClick={() => void copyShareLink('display')}>
                  <span className="share-option-icon">
                    <DisplayIcon size={14} />
                  </span>
                  <span className="share-option-text">
                    <span className="share-option-label">{t(M.forDisplay)}</span>
                    {/* a display follows the owner (live/followTarget.ts); before sharing, that is whoever shares */}
                    <span className="share-option-sub">{t(!collab.room || collab.owner === collab.selfId ? M.forDisplaySub : M.forDisplaySubOther)}</span>
                  </span>
                  <span className="share-option-copy">{t(M.copy)}</span>
                </button>
                {/* what displays list beside the scene, chosen where it shows (components/PresentValues.tsx): one's own Present */}
                {!state.readOnly && (
                  <button
                    className="share-option share-sub-option share-display-edit"
                    data-testid="share-display-edit"
                    title={t(M.displayValuesTitle)}
                    onClick={() => {
                      setShareOpen(false)
                      store.setState({ presenting: true, presentEditing: true })
                      // full screen as a display shows it, and as the Present command opens it: no window buttons over the list
                      void document.documentElement.requestFullscreen?.()?.catch(() => {})
                    }}
                  >
                    <span className="share-option-text">
                      <span className="share-option-sub">
                        {displayedValues(state).length > 0 ? t(M.displayValues, { count: displayedValues(state).length }) : t(M.displayValuesNone)}
                      </span>
                    </span>
                  </button>
                )}
                {collab.room && ownSharedProject() && (
                  <button className="share-option share-back" data-testid="share-stop-sharing" disabled={state.running} onClick={() => void stopSharingProject()}>
                    <span className="share-option-text">
                      <span className="share-option-label">{t(M.stopSharing)}</span>
                      <span className="share-option-sub">
                        {state.running ? t(M.stopSharingRunning) : ownSharedProject()!.demo ? t(M.stopSharingDemoSub) : t(M.stopSharingSub, { name: ownSharedProject()!.project })}
                      </span>
                    </span>
                  </button>
                )}
                {/* a shared project's undo is the room's, kept per person (collab/bridge.ts), so it starts empty */}
                {!collab.room && !shareLabel && store.canUndo && <div className="share-popover-note">{t(M.undoStartsOver)}</div>}
                {shareLabel && (
                  <div className="share-popover-status" role="status">
                    {t(shareLabel)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* No separator after Share: a labelled text button already reads apart from the icon toggles,
            and a rule between every pair of kinds left two rules among four controls. The one rule left
            sets the app's own controls (settings, help) apart from the view toggles. */}
        <button
          className={`icon-toggle${state.mode === 'pilot' ? ' active' : ''}`}
          title={t(M.pilotTitle, {
            label: withKey(commandLabel('sim.pilot'), 'pilot.enter'),
            exit: keyHint('pilot.exit') ?? 'Esc', // i18n-ok: key name
          })}
          aria-label={t(M.pilotMode)}
          aria-pressed={state.mode === 'pilot'}
          onClick={() => (state.mode === 'pilot' ? store.exitPilot() : store.enterPilot())}
        >
          <PilotIcon />
        </button>
        {vrSupported && (
          <button
            data-vr-button
            className={`icon-toggle${vrActive ? ' active' : ''}`}
            title={t(M.vrTitle)}
            aria-label={t(M.vrMode)}
            aria-pressed={vrActive}
            onClick={() => (vrActive ? controller?.exitVR() : void controller?.enterVR(setVrActive))}
          >
            <VRIcon />
          </button>
        )}
        <button
          className={`icon-toggle${state.distractionFree ? ' active' : ''}`}
          title={t(M.distractionFreeTitle, { label: withKey(commandLabel('view.distractionFree'), 'view.distractionFree') })}
          aria-label={t(M.distractionFree)}
          aria-pressed={state.distractionFree}
          onClick={(e) => {
            const entering = !state.distractionFree
            store.toggleDistractionFree()
            // Shift gates *entering* fullscreen; leaving distraction-free always
            // drops fullscreen so any click-out (with or without Shift) undoes it.
            if (entering) {
              if (e.shiftKey) void document.documentElement.requestFullscreen?.()?.catch(() => {})
            } else if (document.fullscreenElement) {
              void document.exitFullscreen().catch(() => {})
            }
          }}
        >
          <DistractionFreeIcon />
        </button>
        <span className="toolbar-sep" aria-hidden="true" />
        {/* Settings has a button of its own, since Help is not where anyone looks for preferences. Hidden on
            the mobile layout (CSS) with the other icon buttons. */}
        <button
          className="icon-toggle settings-button"
          title={withCommandKey(t(M.settings), 'view.settings')}
          aria-label={t(M.settings)}
          onClick={() => runCommand('view.settings')}
        >
          <SettingsIcon />
        </button>
        {/* Help. The tour's "shortcuts" step points HERE (data-tutorial), since this is where the
            reference now lives. Hidden on the mobile layout (CSS) with the other icon buttons: the tour
            is desktop-only, and a phone has no keyboard to look up. Every entry but the GitHub link is a
            command, so the enablement is the registry's, same as the native menus and the palette. */}
        <div className="help-wrap" ref={helpRef}>
          <button
            ref={helpButtonRef}
            className={`icon-toggle help-button${helpOpen ? ' active' : ''}`}
            data-tutorial="shortcuts"
            title={t(M.helpTitle)}
            aria-label={t(M.help)}
            aria-haspopup="menu"
            aria-expanded={helpOpen}
            onClick={(e) => {
              helpByKey.current = fromKeyboard(e)
              setHelpOpen((v) => !v)
            }}
          >
            <HelpIcon />
          </button>
          {helpOpen && (
            <div className="help-popover" role="menu" aria-label={t(M.help)} ref={helpListRef} onKeyDown={menuKeys(closeHelp)}>
              {/* The web has no menu bar, so without this row the palette is reachable only by its chord.
                  The chord badge teaches it. */}
              <button
                className="help-item"
                role="menuitem"
                onClick={() => {
                  closeHelp()
                  runCommand('view.commandPalette')
                }}
              >
                <span className="help-item-label">{getCommand('view.commandPalette')?.label}</span>
                {paletteKey && <kbd className="help-item-key">{paletteKey}</kbd>}
              </button>
              <button
                className="help-item"
                role="menuitem"
                onClick={() => {
                  closeHelp()
                  runCommand('help.shortcuts')
                }}
              >
                <span className="help-item-label">{getCommand('help.shortcuts')?.label}</span>
                {shortcutsKey && <kbd className="help-item-key">{shortcutsKey}</kbd>}
              </button>
              {/* the tour builds and tags parts, so a view link - which cannot edit - leaves it out */}
              {!state.readOnly && tutorialCmd && (
                <button
                  className="help-item"
                  role="menuitem"
                  disabled={!commandEnabled('help.tutorial')}
                  title={t(M.tutorialTitle)}
                  onClick={() => {
                    closeHelp()
                    runCommand('help.tutorial')
                  }}
                >
                  <span className="help-item-label">{tutorialCmd.label}</span>
                </button>
              )}
              {/* the browser's way into the installed app (desktopLink.ts); in a room it opens that room */}
              {!DESKTOP_SHELL && (
                <button
                  className="help-item"
                  role="menuitem"
                  data-testid="help-open-desktop"
                  title={t(state.collab ? M.openDesktopRoom : M.openDesktopCopy)}
                  onClick={() => {
                    closeHelp()
                    runCommand('help.openInDesktop')
                  }}
                >
                  <span className="help-item-label">{getCommand('help.openInDesktop')?.label}</span>
                </button>
              )}
              <div className="help-sep" role="separator" />
              {/* Names a destination, not a surface: this row renders in the desktop app too, where "the
                  desktop version" read as a link to the thing you are already running. */}
              <a
                className="help-item"
                role="menuitem"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={closeHelp}
              >
                <GitHubIcon />
                <span className="help-item-label">{t(M.github)}</span>
                <ExternalLinkIcon />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Live share beside the transport (docs/live-share.md). Anyone running can be watched, so this says what is going on:
 * how many watch this client's run, with the owner's Spotlight; whose run it draws, with a way out and, once the view
 * was moved by hand, Follow view; whom it waits for; or, to an editor, who is running and a Watch. On a phone each chip shrinks to a word, or an eye while watching, so the project name keeps its room (styles/mobile.css).
 */
function LiveControl({ collab, store, state, openPeople }: { collab: ReturnType<typeof getCollabSnapshot>; store: EditorStore; state: EditorState; openPeople: () => void }): ReactElement | null {
  const label = (full: string, short: ReactNode): ReactElement => (
    <>
      <span className="live-chip-full">{full}</span>
      {short && <span className="live-chip-short">{short}</span>}
    </>
  )
  const target = state.liveTarget
  const nameOf = (id: number): string => getPeers().find((p) => p.clientId === id)?.name ?? t(M.someone)
  // a pick is unpicked; a spotlight is dismissed until the next one. A view link's own default has no way out but Play.
  const stopWatching = target && (target.why !== 'view' || state.liveWatch !== null) && (
    <button
      className="live-chip-stop"
      aria-label={t(M.stopWatching)}
      title={t(M.stopWatching)}
      onClick={() => store.setState(target.why === 'spotlight' ? { spotlightDismissed: true } : { liveWatch: null })}
    >
      ×
    </button>
  )
  // the view was moved by hand while following: the run is still followed, the camera no longer (controller/liveCamera.ts)
  const followView = (name: string): ReactElement | false =>
    state.liveViewDetached && (
      <button className="live-chip-action" data-testid="follow-view" title={t(M.followViewTitle, { name })} onClick={() => store.setState({ liveViewDetached: false })}>
        {t(M.followView)}
      </button>
    )
  if (!collab.room) return null
  const owner = collab.owner !== null && collab.owner === collab.selfId
  if (state.running) {
    if (owner && collab.spotlight) {
      return (
        <span className="live-chip on" data-testid="live-chip" title={t(M.spotlightOnTitle)}>
          {label(t(M.spotlightOn, { count: collab.watchers }), t(M.spotlight))}
          <button className="live-chip-action" data-testid="spotlight-stop" title={t(M.stopSpotlightTitle)} onClick={() => setSpotlight(false)}>
            {t(M.stopSpotlight)}
          </button>
        </span>
      )
    }
    const others = collab.peers > 1
    if (collab.watchers === 0 && !(owner && others)) return null
    return (
      <span className={`live-chip${collab.watchers > 0 ? ' on' : ' idle'}`} data-testid="live-chip" title={t(M.watchersTitle)}>
        {collab.watchers > 0 && label(t(M.watchers, { count: collab.watchers }), String(collab.watchers))}
        {owner && others && (
          <button className="live-chip-action" data-testid="spotlight-start" title={t(M.spotlightTitle)} onClick={() => setSpotlight(true)}>
            {t(M.spotlight)}
          </button>
        )}
      </span>
    )
  }
  if (target) {
    const name = nameOf(target.who)
    if (state.liveFollowing) {
      return (
        <span className="live-chip watching" data-testid="live-chip" title={t(M.watchingTitle, { name })}>
          {label(t(target.why === 'spotlight' ? M.watchingSpotlight : M.watching, { name }), <EyeIcon size={12} />)}
          {followView(name)}
          {stopWatching}
        </span>
      )
    }
    return (
      <span className="live-chip waiting" data-testid="live-chip" title={t(M.waitingForTitle)}>
        {label(t(M.waitingFor, { name }), <EyeIcon size={12} />)}
        {followView(name)}
        {stopWatching}
      </span>
    )
  }
  const runners = collab.runners
  if (state.readOnly || runners.length === 0) return null
  if (runners.length === 1) {
    const only = runners[0]!
    return (
      <button className="live-chip offer" data-testid="live-chip" title={t(M.offerWatchTitle, { name: only.name })} onClick={() => store.setState({ liveWatch: only.id })}>
        {label(t(M.offerWatch, { name: only.name }), t(M.watchShort))}
      </button>
    )
  }
  return (
    <button className="live-chip offer" data-testid="live-chip" title={t(M.offerManyTitle)} onClick={openPeople}>
      {label(t(M.offerMany, { count: runners.length }), t(M.watchShort))}
    </button>
  )
}
