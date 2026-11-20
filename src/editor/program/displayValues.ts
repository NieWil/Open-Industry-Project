// The project's display list (SceneJSON.display, core/scene/sceneDisplay.ts) edited from the editor: the right-click
// Show on displays in Watch and the PLC panel, and the values panel in one's own Present (components/PresentValues.tsx).
// Each change is one commit, so it is undone alone. Watch itself is each person's own list; this is the room's screen.

import { MAX_DISPLAY_VALUES, withDisplayed } from '../../core/scene/sceneDisplay'
import type { SceneJSON } from '../../core/types'
import type { EditorState, EditorStore } from '../store/store'
import { documentSceneOf } from '../store/storeDocument'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('displayValues', {
  show: 'Show {name} on displays',
  hide: 'Stop showing {name} on displays',
  add: { one: 'Show {count} value on displays', other: 'Show {count} values on displays' },
  reorder: 'Reorder the values on displays',
})

/** the values displays show now: the document's list, also while a definition session has the scene */
export function displayedValues(state: Pick<EditorState, 'scene' | 'packageEdit'>): readonly string[] {
  return documentSceneOf(state).display ?? []
}

/** the list can be changed here: an editor, outside the Part Editor (whose scene is the part's, not the project's) */
export function canEditDisplay(state: Pick<EditorState, 'readOnly' | 'packageEdit'>): boolean {
  return !state.readOnly && !state.packageEdit
}

/** the list is at its limit, so a value can only be added after another is taken off */
export function displayListFull(state: Pick<EditorState, 'scene' | 'packageEdit'>): boolean {
  return displayedValues(state).length >= MAX_DISPLAY_VALUES
}

function commitList(store: EditorStore, label: string, display: readonly string[] | undefined): void {
  const scene: SceneJSON = store.getState().scene
  const { display: _, ...rest } = scene
  store.commit(label, display && display.length > 0 ? { ...rest, display: [...display] } : rest)
}

/** show one value on displays, or stop showing it */
export function setDisplayed(store: EditorStore, name: string, shown: boolean): void {
  if (!canEditDisplay(store.getState())) return
  const cur = store.getState().scene.display
  if ((cur ?? []).includes(name) === shown) return
  // a full list would cut the new name off, and the commit would be an undo step that changes nothing
  if (shown && (cur?.length ?? 0) >= MAX_DISPLAY_VALUES) return
  commitList(store, t(shown ? M.show : M.hide, { name }), withDisplayed(cur, name, shown))
}

/** show several values on displays, after those already shown, up to the list's limit */
export function addDisplayed(store: EditorStore, names: readonly string[]): void {
  if (!canEditDisplay(store.getState())) return
  const cur = store.getState().scene.display ?? []
  const added = names.filter((n, i) => !cur.includes(n) && names.indexOf(n) === i)
  if (added.length === 0 || cur.length >= MAX_DISPLAY_VALUES) return
  commitList(store, t(M.add, { count: added.length }), [...cur, ...added].slice(0, MAX_DISPLAY_VALUES))
}

/** move the value at `from` to `to` in the display's order */
export function moveDisplayed(store: EditorStore, from: number, to: number): void {
  if (!canEditDisplay(store.getState())) return
  const cur = [...(store.getState().scene.display ?? [])]
  if (from === to || from < 0 || from >= cur.length || to < 0 || to >= cur.length) return
  const [moved] = cur.splice(from, 1)
  cur.splice(to, 0, moved!)
  commitList(store, t(M.reorder), cur)
}
