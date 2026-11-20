import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode } from 'react'
import { followAppearance } from '../appearance'
import { DESKTOP_MAC, DESKTOP_SHELL, getOipMenuApi } from '../desktop/desktopMenuBridge'
import { registerPopoutWindow } from '../dialogHost'
import { watchPopoutStrip } from './popoutStrip'

/**
 * Host a panel in a real OS window, so it can be dragged to a second monitor.
 *
 * The window is a portal target, not a second app: `children` still render inside this
 * document's React tree and this document's JS context, and only their DOM nodes live in the
 * popup. One store, one controller, one sim worker, one CodeMirror buffer: no IPC, no state
 * sync, nothing to diverge. A second `BrowserWindow` (Electron) or a
 * second tab joined to the same room would each be a second app instance, which is the thing
 * this repo's one-core architecture exists to avoid.
 *
 * In Electron the same call produces a genuine native window on the same session (and so the
 * same COOP/COEP), which is why one code path serves both surfaces.
 *
 * Not for the viewport: a WebGL/WebGPU context is bound to its canvas and its
 * document, so the 3D view cannot be portaled anywhere. See POPOUT_PANELS in dockLayout.
 */

interface PopoutWindowProps {
  /** OS window title */
  title: string
  /** localStorage key under which this window's screen rect is remembered */
  geometryKey: string
  /** the window went away (the user closed it) - put the panel back in the layout */
  onClose: () => void
  /**
   * The window could not be used at all, with the reason. The caller is expected to put the
   * panel back somewhere visible: a popout that silently fails is a panel that vanishes.
   */
  onUnavailable: (reason: string) => void
  children: ReactNode
}

interface WindowRect {
  x: number
  y: number
  w: number
  h: number
}

// Big enough for the POU strip + editor + controls without immediately needing a resize; the
// remembered rect takes over from the second use onward.
const DEFAULT_RECT: WindowRect = { x: 120, y: 120, w: 760, h: 680 }
// Guards against restoring a window onto a monitor that is no longer attached: a rect that is
// wildly outside every plausible desktop gets ignored rather than reopened off-screen. Generous
// because a second monitor legitimately sits at negative or far-positive screen X.
const MAX_SCREEN_SPAN = 32000

function readRect(key: string): WindowRect {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_RECT }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...DEFAULT_RECT }
    const g = JSON.parse(raw) as Partial<WindowRect>
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < MAX_SCREEN_SPAN ? v : fallback
    return {
      x: num(g.x, DEFAULT_RECT.x),
      y: num(g.y, DEFAULT_RECT.y),
      // a zero/absurd size would open a window you cannot see, so the size falls back harder
      w: Math.max(320, num(g.w, DEFAULT_RECT.w)),
      h: Math.max(240, num(g.h, DEFAULT_RECT.h)),
    }
  } catch {
    return { ...DEFAULT_RECT }
  }
}

function saveRect(key: string, rect: WindowRect): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(rect))
  } catch {
    // best-effort UI preference, mirroring saveDockLayout
  }
}

export function PopoutWindow({
  title,
  geometryKey,
  onClose,
  onUnavailable,
  children,
}: PopoutWindowProps): ReactElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  // callbacks behind refs: the window is opened by a mount-once effect, which must not tear the
  // window down and rebuild it just because a parent re-rendered with a new closure
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable
  const winRef = useRef<Window | null>(null)

  useEffect(() => {
    const rect = readRect(geometryKey)
    // '' (about:blank) rather than a URL: an about:blank popup inherits the opener's
    // policy container, so it stays cross-origin isolated exactly like /app/ is. That matters
    // twice - it keeps the popup in the same agent cluster (without which this document could
    // not touch its DOM at all, and the portal below would be impossible), and it avoids booting
    // a second copy of the app just to host a panel.
    const features = `popup=yes,width=${rect.w},height=${rect.h},left=${rect.x},top=${rect.y}`
    // The window name is how Electron's main process recognises one of ours and gives it the app
    // icon instead of the one compiled into electron.exe (see POPOUT_FRAME_PREFIX in
    // apps/desktop/main.cjs). Browsers only use it as a reuse target, which is why it is unique
    // per panel: two panels popped out under one name would fight over a single window.
    const name = `oip-popout-${geometryKey.split('/').pop() ?? 'panel'}`
    let win: Window | null
    try {
      win = window.open('', name, features)
    } catch {
      win = null
    }
    if (!win) {
      onUnavailableRef.current('the browser blocked the popup')
      return
    }
    const popup = win

    // The isolation guard. If the popup comes up not matching the opener, the two documents
    // can end up in different agent clusters and every DOM call below would throw cross-origin
    // errors. Refuse here, with a reason, instead of half-opening a window.
    let doc: Document
    try {
      doc = popup.document
      if (!doc) throw new Error('no document')
      if (popup.crossOriginIsolated !== window.crossOriginIsolated) throw new Error('isolation mismatch')
    } catch {
      popup.close()
      onUnavailableRef.current("the popup did not inherit this page's isolation")
      return
    }
    // a fresh about:blank normally has a body already; write a minimal one if it does not
    if (!doc.body) {
      doc.write('<!doctype html><html><head></head><body></body></html>')
      doc.close()
    }
    winRef.current = popup
    // a dialog opened from in here must open in here, and hear this window's keys (dialogHost.ts)
    const unregister = registerPopoutWindow(popup)
    // the mirrored stylesheets pick their theme off the root, which is this document's own (appearance.ts)
    const unfollowAppearance = followAppearance(doc)

    doc.title = title
    // carry the opener's root classes across (e.g. `standalone`, set by main.tsx) so anything
    // keyed off them styles the same in here
    doc.documentElement.className = document.documentElement.className
    // The desktop shell (Windows/Linux) hides this window's OS title bar and paints its buttons over the panel's
    // header row, as it does over the main window's toolbar (apps/desktop/main.cjs popoutTitleBar): the row
    // becomes the drag region and leaves the buttons room (styles.css `.popout-titlebar`).
    // Its colour is reported from here, since the popup runs none of the shell's code (popoutStrip.ts).
    const shell = DESKTOP_SHELL && !DESKTOP_MAC ? getOipMenuApi() : null
    if (shell) doc.documentElement.classList.add('popout-titlebar')
    const stopStrip = shell?.setPopoutStrip ? watchPopoutStrip(popup, (color, symbol) => shell.setPopoutStrip?.(name, color, symbol)) : () => {}
    doc.body.style.margin = '0'
    doc.body.style.overflow = 'hidden'
    // paint the panel's own background immediately: without it the window is white until the
    // copied stylesheets land, which reads as a broken window (light-dark resolves off the root, stamped above)
    doc.body.style.background = 'light-dark(#f7f7f8, #1f2023)'

    const mount = doc.createElement('div')
    mount.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;overflow:hidden'
    doc.body.appendChild(mount)

    // ── stylesheets ────────────────────────────────────────────────────────────────────────
    // A portal moves nodes, not styles: the popup is a different document with an empty head, so
    // every sheet the app relies on has to be mirrored into it. Kept in sync rather than copied
    // once, because sheets arrive late in two ordinary cases - a lazily-imported chunk injecting
    // its CSS, and vite HMR rewriting a <style> node's text in place during dev.
    // (CodeMirror needs nothing here: it mounts its StyleModule into the root node of the view,
    // which is this popup's document once the editor renders inside it.)
    const clones = new Map<Element, Element>()
    const syncStyles = (): void => {
      for (const [src, clone] of clones) {
        if (!src.isConnected) {
          clone.remove()
          clones.delete(src)
        }
      }
      const sources = Array.from(document.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]'))
      for (const src of sources) {
        const existing = clones.get(src)
        if (existing) {
          if (src.tagName === 'STYLE' && existing.textContent !== src.textContent) {
            existing.textContent = src.textContent
          }
          continue
        }
        const clone = src.cloneNode(true) as Element
        doc.head.appendChild(clone)
        clones.set(src, clone)
      }
      // constructed sheets (adoptedStyleSheets) are shared objects, not nodes; a document can
      // only adopt sheets constructed in its own realm, so they are re-made from their text
      const PopupSheet = (popup as unknown as typeof globalThis).CSSStyleSheet
      if (document.adoptedStyleSheets?.length && PopupSheet) {
        try {
          doc.adoptedStyleSheets = document.adoptedStyleSheets.map((sheet) => {
            const copy = new PopupSheet()
            copy.replaceSync(Array.from(sheet.cssRules, (r) => r.cssText).join('\n'))
            return copy
          })
        } catch {
          // an unreadable sheet is skipped: the window opens without that style
        }
      }
    }
    syncStyles()
    const styleObserver = new MutationObserver(syncStyles)
    styleObserver.observe(document.head, { childList: true, subtree: true, characterData: true })

    // ── lifecycle ──────────────────────────────────────────────────────────────────────────
    // Where the user put the window is what matters (the point of the feature is a panel on the
    // other monitor), so the rect is captured on every path out, not only a tidy close.
    let closing = false
    const capture = (): void => {
      if (popup.closed) return
      try {
        saveRect(geometryKey, { x: popup.screenX, y: popup.screenY, w: popup.outerWidth, h: popup.outerHeight })
      } catch {
        // the window is already going away; nothing to remember
      }
    }
    // The window is gone: hand the panel back to the layout, exactly once.
    const finish = (): void => {
      if (closing) return
      closing = true
      window.clearInterval(poll)
      onCloseRef.current()
    }
    // Two routes. `pagehide` is the fast one - it fires while the window still has its
    // screen rect, so it is also where the geometry is captured - but an OS-level close does not
    // raise it reliably across every browser, and a panel left "popped out" with no window is a
    // panel the user cannot reach. The poll is the backstop; 500 ms is one property read.
    const onPopupHide = (): void => {
      capture()
      finish()
    }
    popup.addEventListener('pagehide', onPopupHide)
    popup.addEventListener('beforeunload', onPopupHide)
    const poll = window.setInterval(() => {
      if (popup.closed) finish()
    }, 500)
    // a reload or close of the main window must take its child window with it, or the user is
    // left with an orphan holding a dead React tree
    const onOpenerExit = (): void => {
      capture()
      popup.close()
    }
    window.addEventListener('beforeunload', onOpenerExit)
    window.addEventListener('pagehide', onOpenerExit)

    popup.focus()
    setHost(mount)

    return () => {
      closing = true
      window.clearInterval(poll)
      styleObserver.disconnect()
      stopStrip()
      unregister()
      unfollowAppearance()
      popup.removeEventListener('pagehide', onPopupHide)
      popup.removeEventListener('beforeunload', onPopupHide)
      window.removeEventListener('beforeunload', onOpenerExit)
      window.removeEventListener('pagehide', onOpenerExit)
      capture()
      winRef.current = null
      setHost(null)
      if (!popup.closed) popup.close()
    }
    // Mount-once: `title` is applied by its own effect below, and the callbacks live behind refs.
    // In dev an HMR update re-runs this and re-opens the window; if the browser refuses without a
    // fresh gesture, onUnavailable puts the panel back in the layout rather than losing it.
  }, [geometryKey])

  useEffect(() => {
    const doc = winRef.current?.document
    if (doc) doc.title = title
  }, [title])

  return host ? createPortal(children, host) : null
}
