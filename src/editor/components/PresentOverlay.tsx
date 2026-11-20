// Present (docs/live-share.md "Presenting"): only the scene, for a projector or a display. The editor's chrome is gone
// (App.tsx), and this is all that is drawn over the scene: whose run and view are shown, and a bar to leave. Both fade
// after a few seconds without the mouse moving, and come back when it moves. Escape (controller/keyboard.ts) or leaving
// the browser's fullscreen ends it.
//
// A display link's Present is locked (main.tsx): no bar and no way out but the browser's own. A visitor may move the
// camera; then a button goes back to the followed view, and the screen goes back by itself after half a minute
// untouched, so it never stays where a visitor left it. The cursor hides while the mouse is still.
//
// The PLC values the owner picked with Show on displays (SceneJSON.display) are listed beside the scene, live: the
// followed run's values, or this tab's own run's (components/PresentValues.tsx, which whoever is at the screen can fold,
// move, scroll and filter). They are content, so they never fade with the bar.
//
// A browser goes fullscreen only on a click, so a display link offers Full screen until it is: one click from whoever
// sets the screen up, rather than kiosk mode. A browser already filling the screen (kiosk mode) is not offered it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { getPeers } from '../../collab/session'
import type { TagValue } from '../../plc'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { declaredTypeSets, typeOfKey } from '../program/plcValueText'
import { PresentValues, type DisplayCandidate } from './PresentValues'
import { addDisplayed, canEditDisplay, displayedValues, moveDisplayed, setDisplayed } from '../program/displayValues'
import { listTags } from '../../plc/tags'
import { deviceTags } from '../../plc/bindings'
import { defineMessages, t } from '../../core/i18n'
import { watchKeysOf } from '../../core/watchTable'

const M = defineMessages('present', {
  watching: 'Watching {name}',
  presenting: 'Presenting · Esc to leave',
  editingValues: 'Choosing PLC values · Esc when done',
  fromProgram: 'Program',
  fullscreen: 'Full screen',
  fullscreenTitle: 'Fill the screen with the scene. Leave it with the browser (Esc)',
  back: "Back to {name}'s view",
  exit: 'Exit',
  someone: 'Someone',
})

/** how long the chip and the bar stay after the mouse last moved */
const SHOWN_MS = 3000
/** a locked display untouched this long follows the view again, if a visitor moved it */
const REATTACH_IDLE_MS = 30_000
/** how often the listed values are read: they arrive ten times a second (sim/plcHost.ts WATCH_HZ) */
const VALUES_MS = 125
/** the browser fills the screen: its own fullscreen, or a window in kiosk mode that already covers it */
const fillsScreen = (): boolean => document.fullscreenElement !== null || (window.innerWidth >= screen.width && window.innerHeight >= screen.height)

export function PresentOverlay({ store, state, controller }: { store: EditorStore; state: EditorState; controller: EditorController | null }): ReactElement {
  const [shown, setShown] = useState(true)
  // whether to offer Full screen, which follows the window
  const [full, setFull] = useState(fillsScreen)
  useEffect(() => {
    const measure = (): void => setFull(fillsScreen())
    window.addEventListener('resize', measure)
    document.addEventListener('fullscreenchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('fullscreenchange', measure)
    }
  }, [])
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const wake = (): void => {
      setShown(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setShown(false), SHOWN_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    // leaving the browser's fullscreen (its own Escape) leaves Present too, so one key ends both. The browser takes
    // that Escape before the page sees it, so one pressed in the overlay's filter or search only leaves the field.
    let wasFullscreen = document.fullscreenElement !== null
    const onFullscreen = (): void => {
      if (document.fullscreenElement) {
        wasFullscreen = true
        return
      }
      if (!wasFullscreen || store.getState().presentLocked) return
      const focused = document.activeElement
      if (focused instanceof HTMLInputElement && focused.closest('.present-overlay')) {
        focused.blur()
        return
      }
      store.setState({ presenting: false })
    }
    document.addEventListener('fullscreenchange', onFullscreen)
    // a display shows the browser's own right-click menu to nobody
    const noMenu = (e: MouseEvent): void => {
      if (store.getState().presentLocked) e.preventDefault()
    }
    window.addEventListener('contextmenu', noMenu)
    // a locked display: back to following the view after half a minute nobody touched it
    let touched = Date.now()
    const touch = (): void => {
      touched = Date.now()
    }
    const reattach = setInterval(() => {
      const s = store.getState()
      if (s.presentLocked && s.liveViewDetached && Date.now() - touched >= REATTACH_IDLE_MS) store.setState({ liveViewDetached: false })
    }, 5000)
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) window.addEventListener(ev, touch, { passive: true })
    return () => {
      window.removeEventListener('pointermove', wake)
      document.removeEventListener('fullscreenchange', onFullscreen)
      clearInterval(reattach)
      window.removeEventListener('contextmenu', noMenu)
      document.body.classList.remove('present-idle')
      for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) window.removeEventListener(ev, touch)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      // leaving Present ends editing the display's list
      if (store.getState().presentEditing) store.setState({ presentEditing: false })
    }
  }, [store])

  // no cursor left over the scene while the mouse is still
  useEffect(() => {
    document.body.classList.toggle('present-idle', !shown)
  }, [shown])

  // the picked values, read from the image the run (this tab's, or the one it follows) keeps
  const names = displayedValues(state)
  const [image, setImage] = useState<Readonly<Record<string, TagValue>> | null>(null)
  const ctrlRef = useRef(controller)
  ctrlRef.current = controller
  // an editor in their own Present chooses the list where it shows; a display link never does
  const editable = !state.presentLocked && canEditDisplay(state)
  const listing = names.length > 0 || editable
  // each value's type, as Watch has it: the program's declaration, else what the part wired to it declares. It names
  // what a number means (an INT or a WORD) and formats it (a TIME as T#2s500ms, not milliseconds)
  const declared = useMemo(() => (listing ? declaredTypeSets(state.stProgram) : null), [listing, state.stProgram])
  const parts = state.scene.parts
  const wired = useMemo(() => {
    const m = new Map<string, string>()
    if (listing) for (const d of deviceTags(parts)) for (const f of d.fields) if (f.value !== '' && f.type && !m.has(f.value)) m.set(f.value, f.type)
    return m
  }, [listing, parts])
  const typeOf = useCallback(
    (name: string, key: string | null): string | undefined => (declared ? typeOfKey(declared, key ?? name) : undefined) ?? wired.get(name),
    [declared, wired],
  )
  // the wired tags and the program's variables change with the scene, not with each value read: built once the
  // search first asks, and kept until they change
  const stProgram = state.stProgram
  const fixedCandidates = useMemo(() => {
    let built: Map<string, DisplayCandidate> | null = null
    return () => (built ??= programCandidates(parts, stProgram, typeOf))
  }, [parts, stProgram, typeOf])
  useEffect(() => {
    if (!listing) return
    const read = (): void => setImage(ctrlRef.current?.plcWatch ?? null)
    read()
    const id = setInterval(read, VALUES_MS)
    return () => clearInterval(id)
  }, [listing])

  const target = state.liveTarget
  const name = target ? (getPeers().find((p) => p.clientId === target.who)?.name ?? t(M.someone)) : null
  return (
    <div className={`present-overlay${shown ? ' shown' : ''}${state.presentLocked ? ' locked' : ''}`} data-testid="present-overlay">
      {state.presentLocked && !full && document.fullscreenEnabled && (
        <div className="present-bar">
          <button className="present-exit" data-testid="present-fullscreen" title={t(M.fullscreenTitle)} onClick={() => void document.documentElement.requestFullscreen().catch(() => {})}>
            {t(M.fullscreen)}
          </button>
        </div>
      )}
      {!state.presentLocked && (
        <div className="present-bar">
          <span className="present-bar-label">{t(editable && state.presentEditing ? M.editingValues : M.presenting)}</span>
          <button className="present-exit" data-testid="present-exit" onClick={() => store.setState({ presenting: false })}>
            {t(M.exit)}
          </button>
        </div>
      )}
      {listing && (
        <PresentValues
          names={names}
          image={image}
          typeOf={typeOf}
          locked={state.presentLocked}
          editable={editable}
          editing={editable && state.presentEditing}
          onEditing={(editing) => store.setState({ presentEditing: editing })}
          candidates={() => displayCandidates(fixedCandidates(), image, typeOf)}
          onRemove={(n) => setDisplayed(store, n, false)}
          onAdd={(ns) => addDisplayed(store, ns)}
          onMove={(from, to) => moveDisplayed(store, from, to)}
        />
      )}
      {name && state.liveViewDetached && (
        <button className="present-back" data-testid="present-back" onClick={() => store.setState({ liveViewDetached: false })}>
          {t(M.back, { name })}
        </button>
      )}
      {name && (
        // whose view this is, run or not: between runs a display still shows that person's view, live, so it is not waiting
        <span className="present-chip" data-testid="present-chip">
          {t(M.watching, { name })}
        </span>
      )}
    </div>
  )
}

/** most names offered from the running image: a large program's image holds thousands */
const MAX_IMAGE_CANDIDATES = 2000

type TypeOf = (name: string, key: string | null) => string | undefined

/** the tags wired to parts (named by the part), then the program's variables: each once */
function programCandidates(parts: EditorState['scene']['parts'], stProgram: string, typeOf: TypeOf): Map<string, DisplayCandidate> {
  const out = new Map<string, DisplayCandidate>()
  for (const d of deviceTags(parts)) for (const f of d.fields) if (f.value !== '' && !out.has(f.value)) out.set(f.value, { name: f.value, type: f.type ?? undefined, from: d.name })
  let declared: string[]
  try {
    declared = listTags(stProgram).map((v) => v.name)
  } catch {
    declared = [] // a program that does not parse offers its wired tags only
  }
  const program = t(M.fromProgram)
  for (const n of declared) if (!out.has(n)) out.set(n, { name: n, type: typeOf(n, null), from: program })
  return out
}

/**
 * What the project can show, for the editing panel's search: `fixed` (programCandidates), then whatever else the
 * running image holds (a PLC outside the app's tags). Each once.
 */
function displayCandidates(fixed: ReadonlyMap<string, DisplayCandidate>, image: Readonly<Record<string, TagValue>> | null, typeOf: TypeOf): DisplayCandidate[] {
  const out = [...fixed.values()]
  for (const n of (image ? watchKeysOf(image) : []).slice(0, MAX_IMAGE_CANDIDATES)) if (!fixed.has(n)) out.push({ name: n, type: typeOf(n, n), from: 'PLC' }) // i18n-ok
  return out
}
