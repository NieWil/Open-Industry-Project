// Search-and-run over the command registry (editor/commands.ts), the open scene, and the parts
// catalog. Ctrl+Shift+P, or View → Command Palette… in the desktop menu.
//
// The browser has no menu bar. Without this, Select All Parts and Reset Panel Layout have no path on
// the web (they are desktop menu items), and the rest of the registry needs its chord. One overlay
// covers every command on both surfaces, and it renders the same list the menu does, so the two
// can't disagree.
//
// It also finds things, not just actions (VS Code's Ctrl+P, Blender's F3): a part in the scene, which
// it selects and frames, and a catalog part, which it starts placing. Otherwise both need the mouse
// (the Scene tree's filter box, the catalog's tabs). The ranking that merges the three sources into
// one list is in editor/paletteItems.ts; this component only renders and dispatches.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dialogHost } from '../dialogHost'
import { partDisplayNames, partTypeName } from '../../core/parts/partDisplayName'
import { PART_DEFS } from '../../core/types'
import { commandChord, commandDisabledReason, commandEnabled, groupLabel, runCommand, visibleCommands } from '../commands'
import { DESKTOP_SHELL } from '../desktop/desktopMenuBridge'
import { englishAlias, rankPaletteItems, type PaletteItem } from '../paletteItems'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { defineMessages, messageSource, t } from '../../core/i18n'

const M = defineMessages('palette', {
  groupScene: 'Scene',
  groupParts: 'Parts',
  place: 'place',
  title: 'Command palette',
  placeholder: 'Search commands, scene parts, catalog…',
  search: 'Search commands, scene parts and the catalog',
  empty: 'Nothing matches',
})

/** the chip text: a command's group heading, or the palette's own name for the scene and catalog rows */
function groupChip(item: PaletteItem): string {
  if (item.kind === 'part') return t(M.groupScene)
  if (item.kind === 'catalog') return t(M.groupParts)
  return groupLabel(item.group)
}

interface CommandPaletteProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
  onClose(): void
}

export function CommandPalette({ store, state, controller, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // decided once, as it opens: focus moves into the palette, and must not move the palette with it
  const [host] = useState(dialogHost)

  // The three sources as one list. Rebuilt when the scene or catalog changes, not per keystroke -
  // a 300-part scene would otherwise re-derive its labels on every character.
  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = []
    for (const cmd of visibleCommands({ shell: DESKTOP_SHELL })) {
      out.push({
        key: `cmd:${cmd.id}`,
        kind: 'command',
        group: cmd.group,
        label: cmd.label,
        // the English label (commands.ts localizeCommand registers it under this id) still finds a translated command
        alias: englishAlias(cmd.label, messageSource(`command.${cmd.id}.label`)),
        // in the shortcuts panel's notation (⌘ on a Mac), and the chord this surface binds (F5 is the menu's)
        detail: commandChord(cmd),
        disabled: !commandEnabled(cmd.id),
        // why it is greyed, when the command can say (e.g. no folder picker on Safari/Firefox)
        reason: commandDisabledReason(cmd.id) ?? undefined,
        target: { kind: 'command', id: cmd.id },
      })
    }
    // Part labels are not unique. `partDisplayName` numbers unnamed parts among their siblings, which
    // is right in the tree (you can see the parent) and ambiguous in a flat list: the demo has seven
    // parts called "Box 15", one per pallet stack. So each row carries where it lives, the way VS
    // Code's Quick Open disambiguates same-named files by folder - without it, seven identical rows
    // and Enter picks whichever came first in scene order.
    const byId = new Map(state.scene.parts.map((p) => [p.id, p]))
    // the tree's own labels, so what the palette calls a part is what the tree calls it. One pass: the
    // single-part form scans the scene per call, which made this quadratic in the part count
    const names = partDisplayNames(state.scene.parts)
    for (const part of state.scene.parts) {
      const parent = part.parent ? byId.get(part.parent) : undefined
      out.push({
        key: `part:${part.id}`,
        kind: 'part',
        group: 'Scene', // identity: groupChip renders the heading
        label: names.get(part.id) ?? partTypeName(part),
        detail: parent ? (names.get(parent.id) ?? partTypeName(parent)) : partTypeName(part),
        target: { kind: 'part', id: part.id },
      })
    }
    // Placing is an edit, so the catalog rows are offered only where an edit is legal; otherwise a
    // view-only visitor gets rows that silently do nothing.
    if (!state.readOnly && !state.running) {
      for (const [type, def] of Object.entries(PART_DEFS)) {
        if (def.noCatalog) continue
        out.push({
          key: `cat:${type}`,
          kind: 'catalog',
          group: 'Parts', // identity: groupChip renders the heading
          label: def.label,
          detail: t(M.place),
          target: { kind: 'catalog', type },
        })
      }
      for (const pkg of [...state.bundledPackages, ...state.userPackages]) {
        out.push({
          key: `cat:pkg:${pkg.id}`,
          kind: 'catalog',
          group: 'Parts',
          label: pkg.name,
          detail: t(M.place),
          target: { kind: 'catalog', type: 'part', packageId: pkg.id },
        })
      }
    }
    return out
  }, [state.scene.parts, state.bundledPackages, state.userPackages, state.readOnly, state.running])

  const hits = useMemo(() => rankPaletteItems(items, query), [items, query])

  useEffect(() => setActive(0), [query])

  // keep the highlighted row in view while arrowing through a long list
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: PaletteItem) => {
    if (item.disabled) return
    const t = item.target
    onClose()
    if (t.kind === 'command') {
      runCommand(t.id)
      return
    }
    if (t.kind === 'part') {
      // still there? the list is a snapshot, and a delete can land between render and Enter
      if (!state.scene.parts.some((p) => p.id === t.id)) return
      store.selectMany([t.id])
      controller?.view.focusOn([t.id])
      return
    }
    // Catalog: enter click-to-place from the viewport centre, exactly as the catalog card's own
    // keyboard activation does (Catalog.tsx keyboardPlace) - the part then follows the cursor until
    // it is clicked down, so the palette never drops geometry somewhere the user did not look.
    if (!controller) return
    const rect = controller.container.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    controller.beginCatalogPlace(t.type as Parameters<EditorController['beginCatalogPlace']>[0], cx, cy, t.packageId)
    controller.endCatalogPlace(cx, cy, false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return onClose()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : hits.length - 1
      setActive((i) => (hits.length ? (i + step) % hits.length : 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = hits[active]
      if (item) choose(item)
    }
  }

  // mounted in the window the chord was pressed in: with a panel popped out, that is the popup
  return createPortal(
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label={t(M.title)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          className="palette-input"
          autoFocus
          placeholder={t(M.placeholder)}
          value={query}
          aria-label={t(M.search)}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {hits.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              data-kind={item.kind}
              className={`palette-item${i === active ? ' active' : ''}`}
              disabled={item.disabled}
              title={item.reason}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <span className="palette-group">{groupChip(item)}</span>
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-chord">{item.detail}</span>}
            </button>
          ))}
          {hits.length === 0 && <div className="palette-empty">{t(M.empty)}</div>}
        </div>
      </div>
    </div>,
    host,
  )
}
