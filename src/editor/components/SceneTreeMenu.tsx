import { commandDisabledReason, commandEnabled, commandEnabledOn, getCommand, runCommand, runCommandOn, type Command } from '../commands'
import { DESKTOP_SHELL } from '../desktop/desktopMenuBridge'
import type { SdkPart } from '../../core/types'
import { primaryKey } from '../keyHint'
import type { EditorState, EditorStore } from '../store/store'
import type { EditorController } from '../controller'
import { buildTreeNode } from '../treeNode'
import type { TreeNodeSource } from '../treeNode'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('sceneTreeMenu', {
  rename: 'Rename',
  addChild: 'Add Child Node',
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  wrapsFocus: 'The part open in the Part Editor is the top of the tree and cannot be wrapped',
  reparent: 'Reparent to New Node',
  unparent: 'Unparent',
  hide: 'Hide',
  show: 'Show',
  unlock: 'Unlock',
  lock: 'Lock',
  ungroup: 'Select Parts Individually',
  group: 'Select as One',
  lastNode: 'A part needs at least one node',
  delete: 'Delete',
})

// the clipboard block, by command id (editor/commands.ts), with what a selection's properties and tags can be given
const CLIPBOARD_COMMANDS = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.copyProperties', 'edit.pasteProperties', 'edit.assignController'] as const

const MENU_W = 184

interface SceneTreeMenuProps {
  /** the right-clicked row, as a TreeNodeSource + the anchor point (set by SceneTree) */
  menu: { x: number; y: number; src: TreeNodeSource }
  state: EditorState
  store: EditorStore
  controller?: EditorController | null
  onClose: () => void
  /** begin the inline rename input for a part row / a rig-link row (view state owned by SceneTree) */
  beginRename: (id: string) => void
  beginRenameRig: (partId: string, linkName: string) => void
}

/**
 * The scene tree's one context menu for both row kinds: it builds the right-clicked row's
 * TreeNode and gates every item by capability, so scene parts and rig links share the layout. Split
 * out of SceneTree so the tree component keeps only tree-render concerns - and so the menu-scoped
 * derivations below (selection aggregates, move caps, script gates) run only while a menu is open,
 * not on every tree render.
 */
export function SceneTreeMenu({ menu, state, store, controller, onClose, beginRename, beginRenameRig }: SceneTreeMenuProps) {
  // the unified TreeNode for the right-clicked row - drives item visibility (caps) + the rig-side dispatch.
  // The store/controller structurally satisfy the model's dep interfaces.
  const menuNode = buildTreeNode(menu.src, state, { store, controller: controller ?? null })
  const menuIsPart = menuNode.kind === 'part'
  // the rig link the menu targets (for the rename affordance, which begins the inline input - a view concern)
  const menuRig = menu.src.kind === 'rigLink' ? menu.src : null

  const focusId = state.focusedPartId
  const selCount = state.selectedIds.length
  const sel = new Set(state.selectedIds)
  const selectedParts = state.scene.parts.filter((p) => sel.has(p.id))
  const allVisible = selectedParts.length > 0 && selectedParts.every((p) => p.visible !== false)
  const allLocked = selectedParts.length > 0 && selectedParts.every((p) => p.locked === true)
  const allGrouped = selectedParts.length > 0 && selectedParts.every((p) => p.grouped === true)
  // "Unparent" lifts to the top of the document (store.unparent): the scene root, or the focused
  // part inside a session, so a part already directly under the focused part has nowhere to go
  const canUnparent = selectedParts.some((p) => p.id !== focusId && (p.parent ?? null) !== focusId)
  // ...and for the same reason the focused part can't be wrapped in a new node (store.reparentToNewNode)
  const wrapsFocus = focusId !== null && sel.has(focusId)
  // the part actions target a single custom part
  const oneCustom = selectedParts.length === 1 && selectedParts[0]!.type === 'part' ? (selectedParts[0]! as SdkPart) : null
  // Move Up/Down reorder within a sibling group (mirrors store.moveSelection): a
  // selection spanning parents, or one already at a sibling edge, can't move that way
  const move = (() => {
    if (selectedParts.length === 0) return { up: false, down: false }
    const parentKey = selectedParts[0]!.parent ?? null
    if (!selectedParts.every((p) => (p.parent ?? null) === parentKey)) return { up: false, down: false }
    const sibs = state.scene.parts.filter((p) => (p.parent ?? null) === parentKey).map((p) => p.id)
    const idxs = sibs.flatMap((id, i) => (sel.has(id) ? [i] : []))
    if (idxs.length === 0) return { up: false, down: false }
    return { up: idxs[0]! > 0, down: idxs[idxs.length - 1]! < sibs.length - 1 }
  })()
  // a part's menu is tall (full scene ops); a rig link's is short (the capability subset) - clamp by kind
  const menuH = menu.src.kind === 'rigLink' ? 232 : 552
  const menuStyle = { left: Math.min(menu.x, window.innerWidth - MENU_W - 8), top: Math.min(menu.y, window.innerHeight - menuH - 8) }

  // Every shortcut in this menu comes from the active keymap, in this platform's notation (⌘ on a Mac).
  // A hard-coded label would keep naming the old key after a rebinding in Settings.
  const bindingLabel = (actionId: string | undefined): string => primaryKey(actionId)
  const chordLabel = (cmd: Command): string => bindingLabel(cmd.keys)

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <>
      <div className="context-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div className="context-menu" style={menuStyle}>
        {/* clipboard + duplicate - multi-select scene ops, part rows only (no rig-link equivalent).
            Rendered from the command registry: these are the same actions the Edit menu, the
            palette and Ctrl+X/C/V/D run, so their enablement is one rule, not a per-surface guess. */}
        {menuIsPart && (
          <>
            {CLIPBOARD_COMMANDS.map((id) => {
              const cmd = getCommand(id)
              return (
                cmd && (
                  <button key={id} className="context-item" disabled={!commandEnabled(id)} title={commandDisabledReason(id) ?? undefined} onClick={run(() => runCommand(id))}>
                    {cmd.label}
                    <span className="context-shortcut">{chordLabel(cmd)}</span>
                  </button>
                )
              )
            })}
            <div className="context-sep" />
          </>
        )}
        {/* Rename - both kinds; for a rig link it begins the inline input via the rig path (view state) */}
        {menuNode.caps.rename && (
          <button
            className="context-item"
            disabled={state.running || (menuIsPart && selCount !== 1)}
            onClick={run(() => (menuRig ? beginRenameRig(menuRig.partId, menuRig.link.name) : beginRename(state.selectedIds[0]!)))}
          >
            {t(M.rename)}<span className="context-shortcut">{bindingLabel('edit.rename')}</span>
          </button>
        )}
        {/* Add Child Node - rig links only (caps.addChild); dispatched through the TreeNode model */}
        {menuNode.caps.addChild && (
          <button className="context-item" disabled={state.running} onClick={run(() => menuNode.addChild())}>
            {t(M.addChild)}
          </button>
        )}
        {/* reorder / reparent - part rows only */}
        {menuIsPart && (
          <>
            <button className="context-item" disabled={!move.up} onClick={run(() => store.moveSelection(-1))}>
              {t(M.moveUp)}<span className="context-shortcut">{bindingLabel('edit.moveUp')}</span>
            </button>
            <button className="context-item" disabled={!move.down} onClick={run(() => store.moveSelection(1))}>
              {t(M.moveDown)}<span className="context-shortcut">{bindingLabel('edit.moveDown')}</span>
            </button>
            <button
              className="context-item"
              disabled={selCount === 0 || wrapsFocus}
              title={wrapsFocus ? t(M.wrapsFocus) : undefined}
              onClick={run(() => store.reparentToNewNode())}
            >
              {t(M.reparent)}<span className="context-shortcut">{bindingLabel('edit.reparent')}</span>
            </button>
            <button className="context-item" disabled={!canUnparent} onClick={run(() => store.unparent(state.selectedIds))}>
              {t(M.unparent)}
            </button>
          </>
        )}
        <div className="context-sep" />
        {/* Hide / Lock - both kinds; a part toggles its whole selection, a rig link toggles itself */}
        {menuNode.caps.hide && (
          <button
            className="context-item"
            disabled={menuIsPart && selCount === 0}
            onClick={run(() => (menuIsPart ? store.setVisible(state.selectedIds, !allVisible) : menuNode.setHidden(!menuNode.flags.hidden)))}
          >
            {(menuIsPart ? allVisible : !menuNode.flags.hidden) ? t(M.hide) : t(M.show)}
            {/* the chord acts on selected parts only, so a rig-link row shows none */}
            {menuIsPart && <span className="context-shortcut">{bindingLabel('edit.toggleVisible')}</span>}
          </button>
        )}
        {menuNode.caps.lock && (
          <button
            className="context-item"
            disabled={menuIsPart && selCount === 0}
            onClick={run(() => (menuIsPart ? store.setLocked(state.selectedIds, !allLocked) : menuNode.setLocked(!menuNode.flags.locked)))}
          >
            {(menuIsPart ? allLocked : menuNode.flags.locked) ? t(M.unlock) : t(M.lock)}
          </button>
        )}
        {menuIsPart && (
          <button
            className="context-item"
            disabled={selCount === 0}
            onClick={run(() => store.setGrouped(state.selectedIds, !allGrouped))}
          >
            {allGrouped ? t(M.ungroup) : t(M.group)}
            <span className="context-shortcut">{bindingLabel(allGrouped ? 'edit.ungroup' : 'edit.group')}</span>
          </button>
        )}
        {menuIsPart && oneCustom && (
          <>
            <div className="context-sep" />
            {/* the part commands (commands.ts part.*) aimed at this part, as its row's icons and the Inspector header run
                them; Reveal in Folder is the desktop's, and the browser leaves it out */}
            {[focusId === oneCustom.id ? 'part.closeScene' : 'part.openScene', 'part.editBehavior', 'part.saveAsNew', 'part.openExternal', ...(DESKTOP_SHELL ? ['part.reveal'] : []), 'part.publish'].map((id) => {
              const target = { partId: oneCustom.id }
              const enabled = commandEnabledOn(id, target)
              return (
                <button
                  key={id}
                  className="context-item"
                  disabled={!enabled}
                  title={enabled ? undefined : (commandDisabledReason(id) ?? undefined)}
                  onClick={run(() => runCommandOn(id, target))}
                >
                  {getCommand(id)?.label ?? id}
                </button>
              )
            })}
          </>
        )}
        <div className="context-sep" />
        {/* Delete - both kinds; a part deletes its selection, a rig link its subtree (disabled + explained
            for the rig's last node, which the controller refuses) */}
        <button
          className="context-item"
          disabled={menuIsPart ? selCount === 0 : state.running || !menuNode.caps.delete}
          title={!menuIsPart && !menuNode.caps.delete ? t(M.lastNode) : undefined}
          onClick={run(() => (menuIsPart ? store.deleteSelection() : menuNode.delete()))}
        >
          {t(M.delete)}
          {/* i18n-ok: a key name */}
          <span className="context-shortcut">Del</span>
        </button>
      </div>
    </>
  )
}
