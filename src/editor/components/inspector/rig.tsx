// --- custom-part panels: runtime diagnostics, PartStatus, PartActions (the rig-node editor is ./rigNode.tsx) ---

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SdkPart } from '../../../core/types'
import { partDiagnosticsFor, partDiagnosticsRev, subscribePartDiagnostics } from '../../../core/parts/partDiagnostics'
import { getPackage, listPackages } from '../../../core/parts/partRegistry'
import { categoryOrder, packageCategory, PART_CATEGORIES } from '../../../core/parts/partCategory'
import { TextField } from './fields'
import { commandEnabledOn, getCommand, runCommandOn } from '../../commands'
import { preloadBehaviorEditor } from '../behaviorEditorChunk'
import type { EditorStore } from '../../store/store'
import type { EditorController } from '../../controller'
import { CopyIcon, ExportIcon, ExternalLinkIcon, FolderIcon, SceneIcon, ScriptIcon, ShareIcon } from '../toolbarIcons'
import { builtInsUpdated } from '../../store/storePackages'
import { builtInUpdateChoices, builtInUpdatedText } from '../builtInUpdate'
import { editedSinceCopied, variantBase } from '../../../core/builtInVersion'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.rig', {
  editorNotReady: 'The editor is not ready.',
  lockedWhy: 'A built-in part keeps its name. Save as New Part makes a copy you can name.',
  name: 'Name',
  nameTip: "The part's name: its catalog card, and the type every placed copy shows",
  categoryTip: 'The catalog tab this part is listed under. Type a new name to start a tab of its own.',
  category: 'Category',
  buildError: 'Latest edit failed validation (the last working version is still active): {error}',
  partFallback: 'part',
  variantChanged: "Made from the app's {name}, which the app has updated since. This part keeps what it was made with.",
  variantSame: "Made from the app's {name}.",
  notLoaded: "Part “{id}” isn't loaded.",
  closeScene: 'Close Part Editor: back to the full scene',
  openScene: 'Open Part Editor',
  openSceneRig: 'Open Part Editor: its {links} nodes and {joints} joints become rows in the Scene dock',
  editBehavior: "Edit Behavior: the part's script, run every simulation step (ctx.setJoint, params, sensors…)",
  saveAsNew: 'Save as New Part: a copy of this part under its own name, to change beside the original. Placed parts are unchanged',
  openExternal: "Open in External Editor: this part's behavior.js from the project folder, in your own editor. What you save there comes back into the app",
  reveal: 'Reveal in Folder: behavior.js in the file manager',
  publish: 'Publish to Part Library: send this part for listing, as a pull request from your GitHub account',
  putOnShelf: 'Put on Shelf: keep this part on the parts shelf, for other projects to place and update from',
})

/**
 * Live runtime problems for one placed part (core/parts/partDiagnostics): a step()/geometry() that threw, a
 * compile failure at attach, an unknown commanded joint/lamp name. The build-time half (validatePart) is
 * `buildError` in PartStatus; this is the sim-run half - a part frozen at its last-good output now
 * explains itself where the author is looking. Subscribes to the diagnostics store (new entries + clears;
 * per-tick repeat counts stay silent by design), so it live-updates while the sim runs.
 */
function PartRuntimeDiagnostics({ partId }: { partId: string }) {
  const subscribe = useCallback((onChange: () => void) => subscribePartDiagnostics(onChange), [])
  useSyncExternalStore(subscribe, partDiagnosticsRev)
  const diags = partDiagnosticsFor(partId)
  if (diags.length === 0) return null
  return (
    <>
      {diags.map((d) => (
        <p key={`${d.source} ${d.message}`} className="inspector-hint rig-error">
          [{d.source}] {d.message}
          {d.count > 1 ? ` (×${d.count})` : ''}
        </p>
      ))}
    </>
  )
}

/**
 * The part's own name and catalog category, shown in place of the copy's Name field when the copy on screen is a
 * Part Editor session's throwaway: its own name would be dropped on Back, and the name an author wants to set
 * there is the part's. A built-in's copy keeps the built-in's name, so its fields are read-only.
 */
export function PartInfoFields({ packageId, builtIn, controller }: { packageId: string; builtIn: boolean; controller: EditorController | null }) {
  const pkg = getPackage(packageId)
  const [problem, setProblem] = useState('')
  // a refused name leaves the field holding what was typed; a new key puts the stored name back
  const [reset, setReset] = useState(0)
  if (!pkg) return null
  const apply = (patch: { name?: string; category?: string }): void => {
    const why = controller ? controller.setPartInfo(packageId, patch) : t(M.editorNotReady)
    setProblem(why)
    if (why !== '') setReset((n) => n + 1)
  }
  const locked = builtIn || !controller
  const lockedWhy = t(M.lockedWhy)
  return (
    <>
      <TextField
        key={reset}
        label={t(M.name)}
        value={pkg.name}
        tooltip={builtIn ? lockedWhy : t(M.nameTip)}
        disabled={locked}
        onCommit={(v) => apply({ name: v })}
      />
      {/* any name: the categories other parts name are offered, so a typo does not quietly start a new tab */}
      <TextField
        key={`category-${reset}`}
        label={t(M.category)}
        value={packageCategory(pkg)}
        tooltip={builtIn ? lockedWhy : t(M.categoryTip)}
        disabled={locked}
        list="part-category-names"
        testid="part-category"
        extra={
          <datalist id="part-category-names">
            {categoryOrder([...PART_CATEGORIES, ...listPackages().map(packageCategory)]).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        }
        onCommit={(v) => apply({ category: v })}
      />
      {problem !== '' && (
        <p className="inspector-hint rig-error" role="status" data-testid="part-info-problem">
          {problem}
        </p>
      )}
    </>
  )
}

/**
 * What is wrong with, or new about, a custom part:the latest blocked edit, problems raised while the sim runs, a
 * built-in the app has changed since this project took its copy, a package that isn't loaded. Shown under the
 * Inspector's header (a placed part's and a rig node's alike) beside the "Operated by Use" banner: these are the
 * selection's state, read before its fields.
 */
export function PartStatus({ part, store, controller, buildError }: { part: SdkPart; store: EditorStore; controller: EditorController | null; buildError?: string }) {
  const pkg = getPackage(part.packageId)
  // has this project changed its copy (what taking the app's version would discard)?
  const ownCopy = store.getState().userPackages.find((p) => p.id === part.packageId)
  const editedHere = ownCopy !== undefined && editedSinceCopied(ownCopy)
  // a variant made from a built-in ("Save as New Part"): what it came from, and whether that has moved on since
  const variant = ownCopy ? variantBase(ownCopy, store.getState().bundledPackages) : undefined
  return (
    <>
      {/* a blocked/failed package edit (store.commitPackage validation, or a desktop build failure): echo the
          ⚠ badge's diagnostics right where the author is editing, not just on the catalog card */}
      {buildError && (
        <p className="inspector-hint rig-error">{t(M.buildError, { error: buildError })}</p>
      )}
      {/* the runtime half: problems raised while the sim runs (throwing step(), unknown joint, …) */}
      <PartRuntimeDiagnostics partId={part.id} />
      {/* this project's version of a built-in the app has changed since: which one to use (builtInUpdate.ts) */}
      {controller && builtInsUpdated(store.getState()).has(part.packageId) && (
        <div className="inspector-hint rig-builtin-updated" data-testid="inspector-builtin-updated">
          <p>{builtInUpdatedText(pkg?.name ?? t(M.partFallback), editedHere)}</p>
          <div className="rig-script-actions">
            {builtInUpdateChoices(controller, part.packageId, pkg?.name ?? t(M.partFallback), editedHere).map((c) => (
              <button key={c.testid} type="button" className="array-add" data-testid={c.testid} title={c.title} disabled={store.getState().readOnly} onClick={c.onClick}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {variant && (
        <p className="inspector-hint" data-testid="inspector-variant-of">
          {t(variant.changedSince ? M.variantChanged : M.variantSame, { name: variant.base.name })}
        </p>
      )}
      {!pkg && <p className="inspector-hint">{t(M.notLoaded, { id: part.packageId })}</p>}
    </>
  )
}

/**
 * What can be done with a custom part, as icon buttons for the Inspector header's right end (InspectorHeader
 * `actions`), the same glyphs as its Scene dock row. Each is a command (commands.ts part.*), aimed at this part:
 * Open Part Editor (pressed, and closing it, while the part is open in it), Edit Behavior, and on the desktop Open
 * in External Editor and, for a part whose files are in the project folder, Reveal in Folder - the last two left out
 * where they cannot apply rather than greyed. A failure flashes over the viewport, as from every surface.
 */
export function PartActions({ part, focused }: { part: SdkPart; focused: boolean }) {
  const target = { partId: part.id }
  const geometry = getPackage(part.packageId)?.geometry
  const openTitle = geometry?.kind === 'rig' ? t(M.openSceneRig, { links: geometry.links.length, joints: geometry.joints.length }) : t(M.openScene)
  const action = (id: string, icon: ReactNode, title: string, extra?: { pressed?: boolean; onPointerEnter?: () => void }) => (
    <button
      key={id}
      type="button"
      className="inspector-head-action"
      aria-label={getCommand(id)?.label ?? id}
      aria-pressed={extra?.pressed}
      title={title}
      disabled={!commandEnabledOn(id, target)}
      onPointerEnter={extra?.onPointerEnter}
      onClick={() => runCommandOn(id, target)}
    >
      {icon}
    </button>
  )
  return (
    <>
      {focused
        ? action('part.closeScene', <SceneIcon />, t(M.closeScene), { pressed: true })
        : action('part.openScene', <SceneIcon />, openTitle, { pressed: false })}
      {action('part.editBehavior', <ScriptIcon />, t(M.editBehavior), {
        onPointerEnter: () => preloadBehaviorEditor(),
      })}
      {action('part.saveAsNew', <CopyIcon />, t(M.saveAsNew))}
      {commandEnabledOn('part.openExternal', target) &&
        action('part.openExternal', <ExternalLinkIcon />, t(M.openExternal))}
      {commandEnabledOn('part.reveal', target) && action('part.reveal', <FolderIcon />, t(M.reveal))}
      {commandEnabledOn('part.publish', target) &&
        action('part.publish', <ExportIcon />, t(M.publish))}
      {commandEnabledOn('part.putOnShelf', target) && action('part.putOnShelf', <ShareIcon />, t(M.putOnShelf))}
    </>
  )
}
