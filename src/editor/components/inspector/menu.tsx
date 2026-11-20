// --- right-click property context menu (Copy / Paste / Copy Path / Revert) ---

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { activeClipboard, activeDocument, isElement, useKeydownEverywhere, windowOf } from '../../dialogHost'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { pasteCompatible } from './paramLogic'
import type { ClipKind, ClipValue } from './paramLogic'
import { comboTookKey } from '../comboKeys'
import { commandDisabledReason, commandEnabled, getCommand, runCommand } from '../../commands'

// --- property clipboard (inspector Copy / Paste Property) ---
let propClipboard: { kind: ClipKind; value: ClipValue } | null = null

/** right-click property menu state (Copy/Paste/Revert) */
export interface PropMenuState {
  x: number
  y: number
  key: string
  kind: ClipKind
  /** the one value to copy; undefined when there isn't one (a mixed multi-selection) */
  value: ClipValue | undefined
  /** what this property would store from a pasted value (clamped, validated), or null when it can't take it */
  accept: (v: ClipValue) => ClipValue | null
  setValue: (v: ClipValue) => void
  revert?: () => void
}

export type OpenCtx = (e: ReactMouseEvent, m: Omit<PropMenuState, 'x' | 'y'>) => void

export interface MenuItem {
  label: string
  disabled?: boolean
  onClick: () => void
  /** the item's tooltip: what it does, or why it is disabled */
  title?: string
  testid?: string
  /** the chord that does the same, shown in the menu's shortcut column (keyHint.ts primaryKey) */
  keys?: string
}

/**
 * Keys belong to an open inspector popup, and only to it. A capture-phase window listener sees them before the
 * controller's own (whose Escape deselects: that unmounted the inspector under the popup and left its state to
 * reappear on the next selection; whose Delete removes the part even though focus sits on a popup button).
 * Escape closes; `onKey` gets first refusal of everything else; nothing propagates past the popup. Native
 * default actions (typing, a focused button's Enter) are untouched.
 */
export function useModalKeys(onClose: () => void, onKey?: (e: KeyboardEvent) => void): void {
  // on every window the app has open: a popped-out panel is a Window of its own, and a key pressed
  // there never reaches this one (dialogHost.ts)
  useKeydownEverywhere((e) => {
    e.stopPropagation()
    // an open combo-box list takes its own keys first - Escape closes the list, not the dialog (comboKeys.ts)
    if (comboTookKey(e)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else {
      onKey?.(e)
    }
  }, true)
}

/** keep Tab inside a popup: past the last control wraps to the first, and Shift+Tab the other way */
export function trapTab(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const list = [
    ...container.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0)
  if (list.length === 0) return
  const active = container.ownerDocument.activeElement // the dialog's OWN document: it may be a popped-out window's
  const at = list.indexOf(active as HTMLElement)
  if (e.shiftKey && at <= 0) {
    e.preventDefault()
    list[list.length - 1]!.focus()
  } else if (!e.shiftKey && (at === -1 || at === list.length - 1)) {
    e.preventDefault()
    list[0]!.focus()
  }
}

/** move focus into a popup on open and hand it back to whatever held it on close */
export function useFocusHandoff(focusInitial: () => void): void {
  const focusRef = useRef(focusInitial)
  focusRef.current = focusInitial
  useEffect(() => {
    // whichever window the popup opened in (and an element of any window: `instanceof` names this one's class)
    const held = activeDocument().activeElement
    const prev = isElement(held) ? held : null
    focusRef.current()
    return () => {
      if (prev?.isConnected) prev.focus({ preventScroll: true })
    }
  }, [])
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = x
    let top = y
    const view = windowOf(el) // the window the menu is IN, which is not this script's when the panel is popped out
    if (left + r.width > view.innerWidth - 4) left = view.innerWidth - 4 - r.width
    if (top + r.height > view.innerHeight - 4) top = view.innerHeight - 4 - r.height
    setPos({ left: Math.max(4, left), top: Math.max(4, top) })
  }, [x, y])
  const enabledItems = (): HTMLButtonElement[] =>
    [...(ref.current?.querySelectorAll<HTMLButtonElement>('.ctx-item') ?? [])].filter((b) => !b.disabled)
  useFocusHandoff(() => enabledItems()[0]?.focus({ preventScroll: true }))
  // menu keyboard: arrows / Home / End walk the enabled items (wrapping); Enter and Space activate natively
  useModalKeys(onClose, (e) => {
    const list = enabledItems()
    if (list.length === 0) return
    const at = list.indexOf(windowOf(ref.current).document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % list.length
    else if (e.key === 'ArrowUp') next = at <= 0 ? list.length - 1 : at - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Tab') next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at + 1) % list.length
    if (next < 0) return
    e.preventDefault()
    list[next]!.focus({ preventScroll: true })
  })
  return (
    <>
      <div className="ctx-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
        {items.map((it, i) =>
          it.label === '-' ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className="ctx-item"
              disabled={it.disabled}
              title={it.title}
              data-testid={it.testid}
              onClick={() => {
                it.onClick()
                onClose()
              }}
            >
              {it.label}
              {it.keys && <span className="ctx-key">{it.keys}</span>}
            </button>
          ),
        )}
      </div>
    </>
  )
}

export function menuItemsFor(m: PropMenuState): MenuItem[] {
  const clip = propClipboard
  const pasted = clip && pasteCompatible(clip.kind, m.kind) ? m.accept(clip.value) : null
  const items: MenuItem[] = [
    {
      label: 'Copy Property',
      disabled: m.value === undefined,
      onClick: () => {
        if (m.value !== undefined) propClipboard = { kind: m.kind, value: m.value }
      },
    },
    {
      label: 'Paste Property',
      disabled: pasted === null,
      onClick: () => {
        if (pasted !== null) m.setValue(pasted)
      },
    },
    {
      label: 'Copy Property Path',
      onClick: () => {
        void activeClipboard()?.writeText(m.key)
      },
    },
  ]
  if (m.revert) {
    items.push({ label: '-', onClick: () => {} })
    items.push({ label: 'Revert to Default', onClick: m.revert })
  }
  // the whole part's properties, beside the one row's (commands.ts edit.copyProperties / edit.pasteProperties)
  items.push({ label: '-', onClick: () => {} })
  for (const id of ['edit.copyProperties', 'edit.pasteProperties']) {
    const enabled = commandEnabled(id)
    items.push({
      label: getCommand(id)?.label ?? id,
      disabled: !enabled,
      title: enabled ? undefined : (commandDisabledReason(id) ?? undefined),
      testid: `prop-menu-${id}`,
      onClick: () => runCommand(id),
    })
  }
  return items
}
