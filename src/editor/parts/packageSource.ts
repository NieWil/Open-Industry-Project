// The desktop shell's part folders, as the editor sees them: a source to import from, never a live second home.
//
// A project's part definitions live only in its own copies (store.userPackages). On the desktop they are stored in the
// project folder's parts/, which the project folder sync writes and reads like any other project file
// (externalEditor.ts). So a folder of parts the user points at (Import part > A folder of parts…) is imported: each
// part is built, checked and added to this project, and from then on belongs to this project.
// The folder is not watched. A watched folder would load its parts into whatever project is open, so a part edited in
// one project would show up in another.
//
// No-op in the browser (no window.oipParts).

import { registerPackage } from '../../core/parts/partRegistry'
import { validatePartPackage } from '../../core/parts/partValidate'
import { buildPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { getOipPartsApi } from '../desktop/desktopPartsBridge'
import type { WorkspaceScan } from '../desktop/desktopPartsBridge'
import type { EditorStore } from '../store/store'

/** One part's build result, for the build-failure toast + catalog badge (store.applyPackageStatuses). */
export interface PackageStatus {
  id: string
  name: string
  dir: string
  ok: boolean
  error?: string
}

export interface DesktopPackageSource {
  disconnect(): void
}

const LEGACY_TOLD_KEY = 'oip-web/legacy-parts-told'

/**
 * Parts in the legacy profile-wide custom-parts folder don't load on their own, since a part there belongs to no
 * project. They are still on disk, and any copy placed in a scene keeps working from the scene's own snapshot.
 * So say once per profile where they are and how to bring them into a project. Exported for its unit test.
 */
export function tellAboutLegacyParts(store: Pick<EditorStore, 'showSaveNotice'>, root: string, names: readonly string[]): void {
  if (names.length === 0) return
  try {
    if (localStorage.getItem(LEGACY_TOLD_KEY)) return
    localStorage.setItem(LEGACY_TOLD_KEY, '1')
  } catch {
    return // no storage: better silent than the same notice on every launch
  }
  const n = names.length
  const shown = names.slice(0, 3).join(', ') + (n > 3 ? ` and ${n - 3} more` : '')
  store.showSaveNotice(
    'Parts now live in each project',
    `${n} part${n === 1 ? '' : 's'} in ${root} (${shown}) ${n === 1 ? 'is' : 'are'} no longer loaded on ${n === 1 ? 'its' : 'their'} own. Copies already placed in a scene keep working. To use the rest in a project, Import part in the Parts panel brings them in: choose A folder of parts.`,
  )
}

/**
 * Import every part of a scanned folder into the project's parts: built and checked the way any stored part is,
 * registered as this project's own (replacing a same-id part, as importing a part file does), and kept. Returns a
 * status per part (a part that fails to build is reported, not imported). Exported for its unit test.
 */
export function importScannedParts(store: EditorStore, scan: WorkspaceScan): PackageStatus[] {
  const statuses: PackageStatus[] = []
  for (const part of scan.parts) {
    try {
      const pkg = buildPackage(JSON.parse(part.manifestJson) as PackageManifest, part.behaviorSource)
      const problems = validatePartPackage(pkg)
      if (problems.length > 0) throw new Error(problems.map((p) => `${p.field}: ${p.message}`).join('\n'))
      registerPackage(pkg, true)
      store.addUserPackage(pkg)
      statuses.push({ id: pkg.id, name: pkg.name, dir: part.dir, ok: true })
    } catch (e) {
      statuses.push({ id: part.id, name: part.name, dir: part.dir, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  for (const prob of scan.problems) statuses.push({ id: prob.dir, name: prob.dir, dir: prob.dir, ok: false, error: prob.message })
  return statuses
}

/**
 * Import part's "A folder of parts…" (Catalog.tsx), on the desktop: the shell picks the folder and scans it, and its
 * parts are imported into the project's parts, each one's build result reported on its card and in a toast.
 */
export async function importPartsFolder(store: EditorStore): Promise<void> {
  const scan = await getOipPartsApi()?.pickWorkspace()
  if (!scan) return
  const statuses = importScannedParts(store, scan)
  store.applyPackageStatuses(statuses)
  const n = statuses.filter((s) => s.ok).length
  if (n > 0) store.showSaveNotice('Parts imported', `${n} part${n === 1 ? '' : 's'} from ${scan.root} ${n === 1 ? 'is' : 'are'} now in this project.`)
}

/**
 * On the desktop, mention once where the parts in the old profile-wide folder went (tellAboutLegacyParts). Returns
 * null in the browser.
 */
export function connectDesktopPackages(store: EditorStore): DesktopPackageSource | null {
  const api = getOipPartsApi()
  if (!api) return null
  void api.legacyParts?.().then(({ root, names }) => tellAboutLegacyParts(store, root, names)).catch(() => {})
  return { disconnect() {} }
}
