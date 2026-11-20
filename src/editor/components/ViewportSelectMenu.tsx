import { useEffect } from 'react'
import { PART_DEFS } from '../../core/types'
import { getPackage } from '../../core/parts/partRegistry'
import { packageCategory } from '../../core/parts/partCategory'
import type { EditorState, EditorStore } from '../store/store'
import { categoryIcon } from './SceneTree'
import { TreeGlyph } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('viewportSelect', {
  part: 'Part',
  itemTitle: '{name}\nType: {type}\nId: {id}',
})

interface ViewportSelectMenuProps {
  store: EditorStore
  state: EditorState
}

const MENU_W = 220
const ITEM_H = 30

/**
 * The list-select popup: the parts overlapping under the cursor, nearest-first,
 * so an occluded one can be picked.
 * Opened by the controller on Alt+RMB or a List Select tool click.
 */
export function ViewportSelectMenu({ store, state }: ViewportSelectMenuProps) {
  const menu = state.listSelect

  // Esc closes the picker without also clearing the selection - capture phase
  // beats the controller's window keydown (mirrors the scene-tree context menu).
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      store.closeListSelect()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, store])

  if (!menu) return null

  const pick = (id: string) => {
    if (menu.append) store.toggleSelect(id)
    else store.select(id)
    store.closeListSelect()
  }

  const height = menu.items.length * ITEM_H + 8
  const left = Math.min(menu.x, window.innerWidth - MENU_W - 8)
  const top = Math.min(menu.y, window.innerHeight - height - 8)

  return (
    <>
      <div
        className="context-backdrop"
        onClick={() => store.closeListSelect()}
        onContextMenu={(e) => {
          e.preventDefault()
          store.closeListSelect()
        }}
      />
      <div className="context-menu list-select-menu" style={{ left, top, minWidth: MENU_W }}>
        {menu.items.map((item) => {
          const def = PART_DEFS[item.type]
          // Every part is an SDK part now, so the type label is the part's real package identity
          // (e.g. "Belt Conveyor") - never the generic "Custom Part". Mirrors the scene tree.
          const typeLabel = item.type === 'part' ? (getPackage(item.packageId ?? '')?.name ?? t(M.part)) : def.label
          return (
            <button
              key={item.id}
              className="context-item"
              title={t(M.itemTitle, { name: item.name, type: typeLabel, id: item.id })}
              onClick={() => pick(item.id)}
            >
              <span className="list-select-row">
                <span className="tree-icon"><TreeGlyph kind={categoryIcon(item.type === 'part' ? packageCategory(getPackage(item.packageId ?? '')) : def.category)} /></span>
                <span className="list-select-name">{item.name}</span>
              </span>
              <span className="context-shortcut">{typeLabel}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
