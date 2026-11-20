import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentDoorApi, onAgentDoorReveal, takeAgentDoorReveal, type AgentDoorState } from '../agent/desktopAgent'
import { collabServerPref, defaultCollabUrl, isCollabServerUrl, setCollabServerPref } from '../../collab/collabServer'
import type { ReactElement } from 'react'
import {
  activeKeymap,
  bindingMatches,
  chordFromEvent,
  DEFAULT_KEYMAP,
  formatChord,
  isRebound,
  KEY_GROUPS,
  keyGroupLabel,
  keyHintText,
  keyLabel,
  keymapRev,
  subscribeKeymap,
  type KeyBinding,
} from '../../core/keymap'
import { activeNav, NAV_PRESETS, navRev, subscribeNav, type NavStyle } from '../../core/navigation'
import {
  activeRendererKind,
  graphicsTierPref,
  rendererPref,
  setGraphicsTierPref,
  setRendererPref,
  setShadowQualityPref,
  shadowQualityPref,
  type GraphicsTierPref,
  type RendererPref,
  type ShadowQuality,
} from '../../render/quality'
import { forgetTrustedRooms, trustedRoomCount } from '../../collab/codeTrust'
import { getDisplayName, setDisplayName } from '../../collab/session'
import { appearancePref, setAppearancePref, type Appearance } from '../appearance'
import { browserLanguage, languagePref, ownLanguageName, setLanguagePref, translatorSupported, type LanguagePref } from '../autoTranslate'
import { rebindAction, resetAction, resetAllActions } from '../keymapPrefs'
import { getCommand, runCommand } from '../commands'
import { setNavPref } from '../navigationPrefs'
import { withKey } from '../keyHint'
import { currentBuildLabel } from '../buildStamp'
import {
  addedLibraryUrls,
  LIBRARIES_CHANGED,
  OFFICIAL_PART_LIBRARIES,
  officialLibrariesOff,
  setLibraryUrls,
  setOfficialLibraryOn,
} from '../parts/partLibraryUrls'
import type { EditorState, EditorStore } from '../store/store'
import { CloseIcon } from './toolbarIcons'
import { getShelfApi } from '../parts/partShelf'
import { refreshShelf, useShelf } from '../parts/shelfListing'
import { defineMessages, t, type MessageId } from '../../core/i18n'
import { tNodes } from '../i18nNodes'

const M = defineMessages('settings', {
  tierAuto: 'Automatic',
  tierAutoHint: 'detected from the device',
  tierFull: 'Full',
  tierFullHint: 'higher pixel ratio, MSAA, separate shadow passes',
  tierReduced: 'Reduced',
  tierReducedHint: 'for a weak GPU or a machine that gets hot',
  shadowLow: 'Low',
  shadowMedium: 'Medium',
  shadowHigh: 'High',
  shadowVeryHigh: 'Very high',
  themeSystem: 'System',
  themeSystemHint: "follows this computer's light or dark setting",
  themeLight: 'Light',
  themeDark: 'Dark',
  themePanelsHint: 'panels and editors; the 3D view keeps its own lighting',
  appearance: 'Appearance',
  theme: 'Theme',
  language: 'Language',
  languageAuto: 'Automatic ({language})',
  languageEnglish: 'English',
  languageAutoHint: 'Your browser translates the editor on this device. Tags, programs and part names stay as written.',
  languageNoTranslator: 'This browser has no built-in translator, so the editor stays in English.',
  languageBrowserEnglish: "Your browser's language is English.",
  languageReloadNote: 'The language changes on the next load.',
  resetLayoutHint: 'docks, panel sizes and tabs back to their defaults',
  reset: 'Reset',
  navigation: 'Navigation',
  mouseStyle: 'Mouse style',
  invertZoom: 'Invert wheel zoom',
  invertZoomHint: 'reverses which way the wheel zooms; pinch is unchanged',
  on: 'On',
  off: 'Off',
  orbitSelection: 'Orbit around selection',
  orbitSelectionHint: 'an orbit turns about the selected parts while they are in view',
  editing: 'Editing',
  trackball: 'Trackball rotate',
  trackballHint: "free-rotate from inside the Rotate gizmo's rings",
  graphics: 'Graphics',
  perfReadout: 'Performance read-out',
  perfReadoutHint: 'fps, frame and physics ms, cargo count, draw calls',
  shown: 'Shown',
  hidden: 'Hidden',
  quality: 'Quality',
  shadowDetail: 'Shadow detail',
  shadowDetailHint: 'shadow-map resolution; lower costs less GPU memory',
  renderer: 'Renderer',
  rendererAutoHint: 'WebGPU where it works, else WebGL',
  rendererAutoHintRunning: 'WebGPU where it works, else WebGL; this window runs {renderer}',
  rendererWebglHint: 'WebGL only, for a graphics driver that misbehaves under WebGPU',
  rendererWebglHintRunning: 'WebGL only, for a graphics driver that misbehaves under WebGPU; this window runs {renderer}',
  rendererAuto: 'Automatic',
  reloadNote: 'Graphics settings take effect on the next load.',
  reloadNow: 'Reload now',
  liveEditing: 'Live editing',
  yourName: 'Your name',
  yourNameHint: 'shown to others in a shared project; empty shows an animal',
  collabServer: 'Collaboration server',
  collabServerHint: "where the rooms you start are kept, as ws:// or wss://; empty uses the Open Industry Project's server. Links you share name it.",
  collabServerBad: 'not a ws:// or wss:// address, so the default server stays',
  namePlaceholder: 'shown to collaborators',
  trustedRooms: 'Shared projects allowed to run part code',
  trustedHint: {
    one: '{count} shared project; a forgotten one asks again when next opened',
    other: '{count} shared projects; a forgotten one asks again when next opened',
  },
  forgetAll: 'Forget all',
  partLibraries: 'Part libraries',
  officialLibraries: 'Official libraries',
  noneYet: 'none published yet',
  officialLibrary: 'official library',
  remove: 'Remove',
  addLibrary: 'Add a library',
  addLibraryHint: "another publisher's library or a mirror: the address of its index.json",
  addLibraryHintShelf: "another publisher's library or a mirror: the address of its index.json. A team shares its own parts on the parts shelf, below.",
  reading: 'Reading…',
  add: 'Add',
  partsShelf: 'Parts shelf',
  shelfFolder: 'Folder',
  shelfFolderHint: 'parts kept outside any project, for every project to place and update from. A shared drive or a git repository lets a team work from one set.',
  shelfNotRead: 'not read yet',
  showFolder: 'Show folder',
  changeFolder: 'Change folder…',
  agentConnections: 'Agent connections',
  allowAgents: 'Allow AI agents to connect',
  allowAgentsHint: 'lets an AI agent on this computer edit and run the open project. Any program on this computer can connect while it is on.',
  agentCouldNotStart: 'Agent connections could not start: {error}',
  agentUrl: 'Server address',
  agentUrlHint: 'give this to your agent as an MCP server',
  keysIntro:
    "Tools, snapping and fly/walk movement follow each key's {position}, so the clusters stay put on an AZERTY or QWERTZ keyboard. {ctrl} shortcuts follow the printed letter, the way every other app does it. Click a shortcut to change it.",
  position: 'position',
  alreadyBound: '{chord} is already {label}',
  restoreAll: 'Restore all defaults',
  searchShortcuts: 'Search shortcuts',
  noShortcutMatch: 'No shortcut matches “{query}”',
  pressKey: 'Press a key…',
  escapeFixed: 'Escape always means back out; it cannot be rebound',
  clickToChange: 'Click to change',
  or: 'or',
  orSep: ' or ',
  restoreDefaultFor: 'Restore default for {label}',
  defaultChords: 'Default: {chords}',
  copy: 'Copy',
  copied: 'Copied',
  settings: 'Settings',
  close: 'Close',
  preferences: 'Preferences',
  keyboard: 'Keyboard',
})

/**
 * Settings: preferences and the keyboard editor, in one dialog.
 *
 * Only settings with no other home belong here: the viewport toolbar owns the instant toggles (grid, flow
 * arrows, stats, snapping), and two controls for one state is a bug. What is left is mostly reload-scoped
 * graphics choices: a dialog can say "takes effect on the next load", a toolbar button cannot (see
 * ViewportToolbar.tsx).
 *
 * Everything here is about this browser. A value saved with the document must never be added to Preferences, or it
 * would look personal while changing everyone's copy: a scene's own settings (its physics step rate) are in the
 * Inspector with nothing selected (inspector/scene.tsx).
 *
 * Debug flags (`?nobundle`, `?noinstancepool`, `?dpr`, `?msaa`, ...) stay URL flags:
 * they are A/B kill-switches and benchmark arms. A setting a user can leave on must be supported forever; a
 * flag lasts one load.
 */
interface SettingsOverlayProps {
  store: EditorStore
  state: EditorState
  /** which tab opens first: the '?' chord and the Help menu land on Keyboard, the command on Preferences */
  initialTab?: SettingsTab
  onClose: () => void
}

export type SettingsTab = 'preferences' | 'shortcuts'

// ⌘/⌥ instead of Ctrl/Alt on a Mac. The keymap is headless, so the platform comes from here.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

const TIERS: { value: GraphicsTierPref; label: MessageId; hint: MessageId }[] = [
  { value: 'auto', label: M.tierAuto, hint: M.tierAutoHint },
  { value: 'desktop', label: M.tierFull, hint: M.tierFullHint },
  { value: 'mobile', label: M.tierReduced, hint: M.tierReducedHint },
]

const SHADOWS: { value: ShadowQuality; label: MessageId }[] = [
  { value: 'low', label: M.shadowLow },
  { value: 'medium', label: M.shadowMedium },
  { value: 'high', label: M.shadowHigh },
  { value: 'veryHigh', label: M.shadowVeryHigh },
]

const APPEARANCES: { value: Appearance; label: MessageId; hint: MessageId }[] = [
  { value: 'system', label: M.themeSystem, hint: M.themeSystemHint },
  { value: 'light', label: M.themeLight, hint: M.themePanelsHint },
  { value: 'dark', label: M.themeDark, hint: M.themePanelsHint },
]

/** a table entry's hint, resolved for display */
const hintOf = (id: MessageId | undefined): string | undefined => (id === undefined ? undefined : t(id))

/** the default chords for an action, for the "reset" affordance's tooltip */
function defaultChords(id: string): readonly string[] {
  return DEFAULT_KEYMAP.find((b) => b.id === id)?.keys ?? []
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactElement }) {
  return (
    <div className="setting-row">
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className="setting-control">{children}</span>
    </div>
  )
}

function PreferencesSection({ store, state }: { store: EditorStore; state: EditorState }): ReactElement {
  // The two graphics prefs are resolved once at module load (a live shadow-map resize destroys a
  // texture that recorded WebGPU bundles hold by handle; see quality.ts), so they are held as local
  // state here and applied on the next load. Saying so is the dialog's job.
  const [tier, setTier] = useState<GraphicsTierPref>(() => graphicsTierPref())
  const [shadow, setShadow] = useState<ShadowQuality>(() => shadowQualityPref())
  const [bootTier] = useState<GraphicsTierPref>(() => graphicsTierPref())
  const [bootShadow] = useState<ShadowQuality>(() => shadowQualityPref())
  const [renderer, setRenderer] = useState<RendererPref>(() => rendererPref())
  const [bootRenderer] = useState<RendererPref>(() => rendererPref())
  const needsReload = tier !== bootTier || shadow !== bootShadow || renderer !== bootRenderer
  // what this window actually got, which 'Automatic' alone cannot say (a device with no WebGPU falls back)
  const running = activeRendererKind()
  const runningName = running ? (running === 'webgpu' ? 'WebGPU' : 'WebGL') : null // i18n-ok: renderer API names
  const rendererHint =
    renderer === 'auto'
      ? runningName
        ? t(M.rendererAutoHintRunning, { renderer: runningName })
        : t(M.rendererAutoHint)
      : runningName
        ? t(M.rendererWebglHintRunning, { renderer: runningName })
        : t(M.rendererWebglHint)
  // applies live, unlike the graphics pair below: it is only CSS (appearance.ts)
  const [appearance, setAppearance] = useState<Appearance>(() => appearancePref())
  // applies on the next load, like the graphics prefs: a mounted tree keeps the strings it rendered
  const [language, setLanguage] = useState<LanguagePref>(() => languagePref())
  const [bootLanguage] = useState<LanguagePref>(() => languagePref())
  const browserLang = browserLanguage()
  const languageHint = !translatorSupported()
    ? t(M.languageNoTranslator)
    : browserLang === null
      ? t(M.languageBrowserEnglish)
      : t(M.languageAutoHint)
  // the Trackball hint names its chord from the active keymap, and the Keyboard tab next door is
  // where that chord gets rebound, so re-render on one, the way the toolbar's tooltips do
  useSyncExternalStore(subscribeKeymap, keymapRev)
  // applies live: the view reads it on the next modifier change / wheel tick (core/navigation.ts)
  useSyncExternalStore(subscribeNav, navRev)
  const nav = activeNav()

  return (
    <div className="settings-body">
      {/* Trackball came off the viewport toolbar, where it sat beside Local Space because the two are the
          same KIND of thing - persisted toggles that change how a gizmo answers a drag. They part company
          on how often you touch them: Local Space changes what every drag on an angled part does, while
          this decides once whether the rotate rings' interior sphere free-rotates, and on a conveyor it
          decides nothing at all (rotateYawOnly locks the tilt rings). Once-ever is what this tab is for. */}
      <section className="settings-group">
        <h3>{t(M.appearance)}</h3>
        <Row label={t(M.theme)} hint={hintOf(APPEARANCES.find((a) => a.value === appearance)?.hint)}>
          <select
            className="setting-select"
            data-testid="setting-theme"
            value={appearance}
            onChange={(e) => {
              const v = e.target.value as Appearance
              setAppearance(v)
              setAppearancePref(v)
            }}
          >
            {APPEARANCES.map((a) => (
              <option key={a.value} value={a.value}>
                {t(a.label)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t(M.language)} hint={languageHint}>
          <select
            className="setting-select"
            data-testid="setting-language"
            value={language}
            onChange={(e) => {
              const v = e.target.value as LanguagePref
              setLanguage(v)
              setLanguagePref(v)
            }}
          >
            <option value="auto">{t(M.languageAuto, { language: browserLang ? ownLanguageName(browserLang) : t(M.languageEnglish) })}</option>
            <option value="en">{t(M.languageEnglish)}</option>
          </select>
        </Row>
        {language !== bootLanguage && (
          <div className="settings-note" role="status">
            {t(M.languageReloadNote)}
            <button type="button" className="settings-note-action" onClick={() => location.reload()}>
              {t(M.reloadNow)}
            </button>
          </div>
        )}
        {/* The browser has no View menu, so the reset needs a home a mouse can find. It runs the command so the
            palette and the desktop menu share its behaviour. */}
        <Row label={getCommand('view.resetLayout')?.label ?? ''} hint={t(M.resetLayoutHint)}>
          <button type="button" className="setting-button" data-testid="setting-reset-layout" onClick={() => runCommand('view.resetLayout')}>
            {t(M.reset)}
          </button>
        </Row>
      </section>

      {/* One setting, for the middle button only: CAD tools disagree on whether the middle button orbits or pans, and someone
          who has panned on it for years reads an orbit as a broken app. Labels say what happens, never which
          product it imitates. */}
      <section className="settings-group">
        <h3>{t(M.navigation)}</h3>
        <Row label={t(M.mouseStyle)} hint={NAV_PRESETS.find((p) => p.id === nav.style)?.hint}>
          <select
            className="setting-select"
            data-testid="setting-nav-style"
            value={nav.style}
            onChange={(e) => setNavPref({ style: e.target.value as NavStyle })}
          >
            {NAV_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t(M.invertZoom)} hint={t(M.invertZoomHint)}>
          <label className="setting-switch">
            <input
              type="checkbox"
              data-testid="setting-invert-zoom"
              checked={nav.invertZoom}
              onChange={(e) => setNavPref({ invertZoom: e.target.checked })}
            />
            <span>{t(nav.invertZoom ? M.on : M.off)}</span>
          </label>
        </Row>
        <Row label={t(M.orbitSelection)} hint={t(M.orbitSelectionHint)}>
          <label className="setting-switch">
            <input
              type="checkbox"
              data-testid="setting-orbit-selection"
              checked={nav.orbitSelection}
              onChange={(e) => setNavPref({ orbitSelection: e.target.checked })}
            />
            <span>{t(nav.orbitSelection ? M.on : M.off)}</span>
          </label>
        </Row>
      </section>

      <section className="settings-group">
        <h3>{t(M.editing)}</h3>
        <Row label={t(M.trackball)} hint={withKey(t(M.trackballHint), 'view.trackball')}>
          <label className="setting-switch">
            <input type="checkbox" checked={state.trackball} onChange={(e) => store.setTrackball(e.target.checked)} />
            <span>{t(state.trackball ? M.on : M.off)}</span>
          </label>
        </Row>
      </section>

      <LiveEditingGroup />

      <PartLibrariesGroup />

      <PartsShelfGroup />

      <AgentConnectionsGroup />

      <section className="settings-group">
        <h3>{t(M.graphics)}</h3>
        {/* First, because this is the instrument you read while turning the two knobs below it, and
            it is also the one control here that applies LIVE - keeping it above the pair keeps it clear of
            the "takes effect on the next load" note, which belongs to them and not to it. */}
        <Row label={t(M.perfReadout)} hint={t(M.perfReadoutHint)}>
          <label className="setting-switch">
            <input type="checkbox" checked={state.showStats} onChange={(e) => store.setShowStats(e.target.checked)} />
            <span>{t(state.showStats ? M.shown : M.hidden)}</span>
          </label>
        </Row>
        <Row label={t(M.quality)} hint={hintOf(TIERS.find((x) => x.value === tier)?.hint)}>
          <select
            className="setting-select"
            value={tier}
            onChange={(e) => {
              const v = e.target.value as GraphicsTierPref
              setTier(v)
              setGraphicsTierPref(v)
            }}
          >
            {TIERS.map((x) => (
              <option key={x.value} value={x.value}>
                {t(x.label)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t(M.shadowDetail)} hint={t(M.shadowDetailHint)}>
          <select
            className="setting-select"
            value={shadow}
            onChange={(e) => {
              const v = e.target.value as ShadowQuality
              setShadow(v)
              setShadowQualityPref(v)
            }}
          >
            {SHADOWS.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.label)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t(M.renderer)} hint={rendererHint}>
          <select
            className="setting-select"
            data-testid="setting-renderer"
            value={renderer}
            onChange={(e) => {
              const v = e.target.value as RendererPref
              setRenderer(v)
              setRendererPref(v)
            }}
          >
            <option value="auto">{t(M.rendererAuto)}</option>
            {/* i18n-ok: renderer API name */}
            <option value="webgl">WebGL</option>
          </select>
        </Row>
        {needsReload && (
          <div className="settings-note" role="status">
            {t(M.reloadNote)}
            <button type="button" className="settings-note-action" onClick={() => location.reload()}>
              {t(M.reloadNow)}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Who you are in a room, and what this browser has decided about rooms' part code.
 *
 * The name is also in the Share popover, but that popover is not offered on a view link, so this is where someone
 * watching a room sets a name instead of the default animal. The trust answers ("allow this room's code") are
 * remembered for good, and a security decision needs a way to take it back; this is it. They are shown as counts
 * because a room's stored name is a hash of its secret (codeTrust.ts). Only a browser where the part sandbox could
 * not start stores an answer, so the row shows only when there is one.
 */
function LiveEditingGroup(): ReactElement {
  const [trusted, setTrusted] = useState(() => trustedRoomCount())
  // decided once per open, so Forget all greys the button out instead of removing the row under the pointer
  const [listTrusted] = useState(trusted > 0)
  const [serverBad, setServerBad] = useState(false)
  return (
    <section className="settings-group">
      <h3>{t(M.liveEditing)}</h3>
      <Row label={t(M.yourName)} hint={t(M.yourNameHint)}>
        <input
          className="setting-input"
          data-testid="setting-display-name"
          type="text"
          maxLength={40}
          placeholder={t(M.namePlaceholder)}
          defaultValue={getDisplayName()}
          onChange={(e) => setDisplayName(e.target.value)}
          // typing a name must not drive the editor's shortcuts; Escape still closes the dialog
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        />
      </Row>
      <Row label={t(M.collabServer)} hint={serverBad ? t(M.collabServerBad) : t(M.collabServerHint)}>
        <input
          className="setting-input"
          data-testid="setting-collab-server"
          type="text"
          maxLength={256}
          placeholder={defaultCollabUrl()}
          defaultValue={collabServerPref() ?? ''}
          onChange={(e) => {
            const v = e.target.value.trim()
            const ok = v === '' || isCollabServerUrl(v)
            setServerBad(!ok)
            if (ok) setCollabServerPref(v === '' ? null : v)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        />
      </Row>
      {listTrusted && (
        <Row label={t(M.trustedRooms)} hint={t(M.trustedHint, { count: trusted })}>
          <button
            type="button"
            className="setting-button"
            data-testid="setting-forget-trusted"
            disabled={trusted === 0}
            onClick={() => {
              forgetTrustedRooms()
              setTrusted(trustedRoomCount())
            }}
          >
            {t(M.forgetAll)}
          </button>
        </Row>
      )}
    </section>
  )
}

/** A library as a row label: its folder (`oip.structure` for `.../oip.structure/index.json`) and host. */
function libraryLabel(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const folder = parts.length > 1 ? parts[parts.length - 2] : parts[0]
    return folder ? `${folder} (${u.host})` : u.host
  } catch {
    return url
  }
}

/**
 * The part libraries the Catalog's Libraries tab reads (docs/part-libraries.md): the project's official ones, each of
 * which can be switched off, and the viewer's own (another publisher's library, a self-hosted mirror). A library is read before
 * it is added, so a wrong address or a host without CORS is said here rather than saved.
 */
function PartLibrariesGroup(): ReactElement {
  const [, setRev] = useState(0)
  useEffect(() => {
    const bump = (): void => setRev((r) => r + 1)
    window.addEventListener(LIBRARIES_CHANGED, bump)
    return () => window.removeEventListener(LIBRARIES_CHANGED, bump)
  }, [])
  const official = OFFICIAL_PART_LIBRARIES
  const off = new Set(officialLibrariesOff())
  const added = addedLibraryUrls()
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' })
  const add = async (): Promise<void> => {
    setStatus({ busy: true, error: '' })
    const { addLibrary } = await import('../parts/partLibraries')
    const refused = await addLibrary(draft)
    if (refused === null) setDraft('')
    setStatus({ busy: false, error: refused ?? '' })
  }
  return (
    <section className="settings-group" data-testid="settings-part-libraries">
      <h3>{t(M.partLibraries)}</h3>
      {official.length === 0 ? (
        <Row label={t(M.officialLibraries)} hint={t(M.noneYet)}>
          <span />
        </Row>
      ) : (
        official.map((url) => (
          <Row key={url} label={libraryLabel(url)} hint={t(M.officialLibrary)}>
            <label className="setting-switch">
              <input type="checkbox" data-testid="setting-official-library" checked={!off.has(url)} onChange={(e) => setOfficialLibraryOn(url, e.target.checked)} />
              <span>{t(off.has(url) ? M.off : M.on)}</span>
            </label>
          </Row>
        ))
      )}
      {added.map((url) => (
        <Row key={url} label={libraryLabel(url)} hint={url}>
          <button type="button" className="setting-button" data-testid="setting-remove-library" onClick={() => setLibraryUrls(added.filter((u) => u !== url))}>
            {t(M.remove)}
          </button>
        </Row>
      ))}
      <Row label={t(M.addLibrary)} hint={status.error || t(getShelfApi() ? M.addLibraryHintShelf : M.addLibraryHint)}>
        <span className="setting-control-pair">
          <input
            className="setting-input"
            data-testid="setting-library-url"
            type="url"
            // i18n-ok: an example address, not prose
            placeholder="https://.../index.json"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // typing must not drive the editor's shortcuts; Escape still closes the dialog
              if (e.key !== 'Escape') e.stopPropagation()
              if (e.key === 'Enter') void add()
            }}
          />
          <button type="button" className="setting-button" data-testid="setting-add-library" disabled={status.busy || draft.trim() === ''} onClick={() => void add()}>
            {t(status.busy ? M.reading : M.add)}
          </button>
        </span>
      </Row>
    </section>
  )
}

/**
 * Where the parts shelf is (docs/parts-shelf.md), and the way to change it. Desktop only: the browser has no shelf.
 * A shelf folder that cannot be read is said above the Catalog's cards, where its parts would be missing.
 */
function PartsShelfGroup(): ReactElement | null {
  const shelf = useShelf()
  const api = getShelfApi()
  if (!shelf || !api) return null
  return (
    <section className="settings-group" data-testid="settings-parts-shelf">
      <h3>{t(M.partsShelf)}</h3>
      <Row label={t(M.shelfFolder)} hint={t(M.shelfFolderHint)}>
        <span className="setting-control-pair">
          <span className="setting-path" data-testid="setting-shelf-path" title={shelf.listing?.root ?? ''}>
            {shelf.listing?.root ?? t(M.shelfNotRead)}
          </span>
          <button type="button" className="setting-button" onClick={() => void api.reveal()}>
            {t(M.showFolder)}
          </button>
          <button
            type="button"
            className="setting-button"
            data-testid="setting-shelf-change"
            onClick={() =>
              void api
                .pickFolder()
                .then((scan) => {
                  if (scan) void refreshShelf()
                })
                .catch((e: unknown) => console.warn('[oip] choosing the shelf folder failed', e))
            }
          >
            {t(M.changeFolder)}
          </button>
        </span>
      </Row>
    </section>
  )
}

/**
 * Whether an AI agent may drive this editor over MCP (the desktop app's agent door, docs/agent-tools.md), and the
 * address to give it. Desktop only. Main owns the server and the choice: turning it on asks in a native dialog
 * first, and the answer is remembered across launches (apps/desktop/agentDoorSetting.cjs). Help > Agent
 * Connections... opens Settings scrolled to here.
 */
function AgentConnectionsGroup(): ReactElement | null {
  const [api] = useState(agentDoorApi)
  const [door, setDoor] = useState<AgentDoorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!api) return
    let live = true
    api
      .doorState()
      .then((s) => {
        if (live) setDoor(s)
      })
      .catch((e: unknown) => console.warn('[oip] reading the agent door failed', e))
    const off = api.onDoorChange((s) => setDoor(s))
    return () => {
      live = false
      off()
    }
  }, [api])
  // a count of requests: read as the dialog opens, and again on each request while it is open; scrolled once the
  // state has rendered the section at its full height
  const [reveal, setReveal] = useState(() => (takeAgentDoorReveal() ? 1 : 0))
  const revealed = useRef(0)
  useEffect(
    () =>
      onAgentDoorReveal(() => {
        if (takeAgentDoorReveal()) setReveal((n) => n + 1)
      }),
    [],
  )
  useEffect(() => {
    if (door && reveal > revealed.current) {
      revealed.current = reveal
      ref.current?.scrollIntoView({ block: 'start' })
    }
  }, [door, reveal])
  if (!api || !door) return null
  const toggle = (on: boolean): void => {
    setBusy(true)
    setError('')
    api
      .setDoor(on)
      .then((s) => {
        setDoor({ enabled: s.enabled, url: s.url })
        if (s.error) setError(t(M.agentCouldNotStart, { error: s.error }))
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <section ref={ref} className="settings-group" data-testid="settings-agent-connections">
      <h3>{t(M.agentConnections)}</h3>
      <Row label={t(M.allowAgents)} hint={error || t(M.allowAgentsHint)}>
        <label className="setting-switch">
          <input type="checkbox" data-testid="setting-agent-door" checked={door.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
          <span>{t(door.enabled ? M.on : M.off)}</span>
        </label>
      </Row>
      {door.enabled && (
        <>
          <Row label={t(M.agentUrl)} hint={t(M.agentUrlHint)}>
            <span className="setting-control-pair">
              <span className="setting-path" data-testid="setting-agent-url" title={door.url}>
                {door.url}
              </span>
              <CopyButton text={door.url} testId="setting-agent-copy-url" />
            </span>
          </Row>
        </>
      )}
    </section>
  )
}

function CopyButton({ text, testId }: { text: string; testId: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="setting-button"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => {},
        )
      }}
    >
      {t(copied ? M.copied : M.copy)}
    </button>
  )
}

/**
 * The keyboard reference, and the keyboard editor.
 *
 * Renders the active keymap table (core/keymap.ts, via `resolveKeymap(overrides)`), the one the listeners
 * resolve against, so a chord shown here is always the chord that fires. Clicking a chord records
 * a new one.
 *
 * Three refusals, each because the alternative is a broken keyboard:
 *   - `fixed` bindings (Escape) are not editable: the handlers pre-empt Escape modally, and rebinding it
 *     would strand a user inside a drag with no way out.
 *   - a chord already used in the same mode is refused by name. Cross-mode reuse is deliberate (W is Move
 *     and fly-forward; those modes are never both live).
 *   - a bare modifier is not a chord; capture keeps waiting rather than recording Shift.
 */
function ShortcutsSection({
  capturing,
  setCapturing,
}: {
  capturing: string | null
  setCapturing: (id: string | null) => void
}): ReactElement {
  const keymap = useSyncExternalStore(subscribeKeymap, activeKeymap)
  useSyncExternalStore(subscribeKeymap, keymapRev)
  /** why the last attempt was refused, shown on the row that was refused */
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null)
  const [query, setQuery] = useState('')
  const shown = keymap.filter((b) => bindingMatches(b, query, IS_MAC))

  // The recorder. Mounted only while a row is capturing, so the app keeps its own keyboard the rest
  // of the time. Capture phase, like the dialog's Esc handler: the editor controller is listening
  // for these keys too and must not act on the press being recorded.
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return // the dialog's handler cancels the capture
      e.preventDefault()
      e.stopPropagation()
      const chord = chordFromEvent(e)
      if (!chord) return // a bare modifier: keep waiting for the key it modifies
      const clash = rebindAction(capturing, [chord])
      if (clash) {
        const other = DEFAULT_KEYMAP.find((b) => b.id === clash)
        const label = other ? keyLabel(other) : clash
        setRefused({ id: capturing, message: t(M.alreadyBound, { chord: formatChord(chord, IS_MAC), label }) })
      } else {
        setRefused(null)
      }
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, setCapturing])

  const beginCapture = (b: KeyBinding): void => {
    if (b.fixed) return
    setRefused(null)
    setCapturing(b.id)
  }

  return (
    <div className="settings-body">
      <p className="author-intro">
        {tNodes(M.keysIntro, {
          position: <strong>{t(M.position)}</strong>,
          ctrl: IS_MAC ? '⌘' : 'Ctrl', // i18n-ok: modifier key name
        })}
      </p>
      <div className="shortcuts-toolbar">
        <input
          className="shortcuts-search"
          data-testid="shortcuts-search"
          type="search"
          placeholder={t(M.searchShortcuts)}
          aria-label={t(M.searchShortcuts)}
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // typing must not drive the editor's shortcuts; Escape still closes the dialog
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        />
        {keymap !== DEFAULT_KEYMAP && (
          <button type="button" className="shortcuts-reset-all" onClick={() => resetAllActions()}>
            {t(M.restoreAll)}
          </button>
        )}
      </div>
      {shown.length === 0 && <p className="shortcuts-empty">{t(M.noShortcutMatch, { query: query.trim() })}</p>}
      <div className="shortcuts-groups">
        {KEY_GROUPS.map((group) => {
          const rows = shown.filter((b) => b.group === group)
          if (rows.length === 0) return null
          return (
            <section className="shortcuts-group" key={group}>
              <h3>{keyGroupLabel(group)}</h3>
              {rows.map((b) => {
                const recording = capturing === b.id
                const changed = isRebound(b.id)
                const refusal = refused?.id === b.id ? refused.message : null
                return (
                  <div className="shortcut-row" key={b.id}>
                    <span className="shortcut-text">
                      <span className="shortcut-label">{keyLabel(b)}</span>
                      {refusal ? <span className="shortcut-refused">{refusal}</span> : b.hint && <span className="shortcut-hint">{keyHintText(b)}</span>}
                    </span>
                    <span className="shortcut-keys">
                      {recording ? (
                        <span className="shortcut-recording">{t(M.pressKey)}</span>
                      ) : b.fixed ? (
                        // shown, never editable - see the header
                        <kbd className="shortcut-fixed" title={t(M.escapeFixed)}>
                          {b.keys.map((c) => formatChord(c, IS_MAC)).join(' / ')}
                        </kbd>
                      ) : (
                        <button type="button" className={`shortcut-edit${changed ? ' changed' : ''}`} title={t(M.clickToChange)} onClick={() => beginCapture(b)}>
                          {b.keys.map((chord, i) => (
                            <Fragment key={chord}>
                              {i > 0 && <span className="shortcut-or">{t(M.or)}</span>}
                              <kbd>{formatChord(chord, IS_MAC)}</kbd>
                            </Fragment>
                          ))}
                        </button>
                      )}
                      {changed && !recording && (
                        <button
                          type="button"
                          className="shortcut-revert"
                          aria-label={t(M.restoreDefaultFor, { label: keyLabel(b) })}
                          title={t(M.defaultChords, { chords: defaultChords(b.id).map((c) => formatChord(c, IS_MAC)).join(t(M.orSep)) })}
                          onClick={() => resetAction(b.id)}
                        >
                          ⟲
                        </button>
                      )}
                    </span>
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** Which build this tab runs (buildStamp.ts), click to copy for a bug report. */
function BuildStamp(): ReactElement {
  const label = currentBuildLabel()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="settings-build"
      data-testid="settings-build"
      title={t(M.copy)}
      onClick={() => {
        void navigator.clipboard?.writeText(label).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => {},
        )
      }}
    >
      {copied ? t(M.copied) : label}
    </button>
  )
}

export function SettingsOverlay({ store, state, initialTab = 'shortcuts', onClose }: SettingsOverlayProps): ReactElement {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  // Help > Agent Connections... while this is open: to the tab its section is on (which takes the request as it mounts)
  useEffect(() => onAgentDoorReveal(() => setTab('preferences')), [])
  /** the action currently recording a chord - owned here because Esc has to choose between
   *  cancelling the capture and closing the dialog, and only one handler can decide that */
  const [capturing, setCapturing] = useState<string | null>(null)
  const stopCapture = useCallback(() => setCapturing(null), [])

  // Capture-phase Esc: the editor controller also listens for Escape (deselect), and this dialog is
  // the thing on top, so it takes the key first. While recording, Esc cancels the recording rather
  // than the dialog - the narrower gesture wins, the way it does everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (capturing) stopCapture()
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, capturing, stopCapture])

  const tabButton = (id: SettingsTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={`settings-tab${tab === id ? ' active' : ''}`}
      onClick={() => {
        setCapturing(null)
        setTab(id)
      }}
    >
      {label}
    </button>
  )

  return (
    // data-shortcuts-overlay is kept as the dialog's handle: it is the same dialog, reached by the
    // same chord, and the gates that drive the keyboard editor already address it by that name.
    <div className="author-backdrop" data-shortcuts-overlay data-settings-tab={tab} onPointerDown={() => (capturing ? stopCapture() : onClose())}>
      <div className="author-dialog shortcuts-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.settings)}</h2>
          <button className="author-close" aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="settings-tabs" role="tablist">
          {tabButton('preferences', t(M.preferences))}
          {tabButton('shortcuts', t(M.keyboard))}
          <BuildStamp />
        </div>
        {tab === 'preferences' ? (
          <PreferencesSection store={store} state={state} />
        ) : (
          <ShortcutsSection capturing={capturing} setCapturing={setCapturing} />
        )}
      </div>
    </div>
  )
}
