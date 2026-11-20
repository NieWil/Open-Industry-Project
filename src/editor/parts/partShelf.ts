// The parts shelf, as the editor sees it (docs/parts-shelf.md): custom parts kept outside any project, for projects to
// copy from. The project's own copies stay the only place its parts come from; the shelf is never read live.
//
// The shell owns the folder (apps/desktop/partsShelf.cjs, window.oipShelf). This module turns its listing into
// parts - built and checked the way every imported part is - and moves parts between the shelf and the open project:
//
//   copyFromShelf   a shelf part into the project's parts, stamped with the version it came from (core/parts/partShelf.ts)
//   putOnShelf      a project part onto the shelf; the project's copy then reads up to date
//
// Desktop only for now: no window.oipShelf in the browser, so getShelfApi() is null and the Catalog shows no shelf.

import { registerPackage } from '../../core/parts/partRegistry'
import { manifestOfPackage } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import type { PartPackage } from '../../core/parts/partPackage'
import { asShelfCopy, forShelf, onShelfAs, shelfStatus } from '../../core/parts/partShelf'
import type { ShelfStatus } from '../../core/parts/partShelf'
import { buildPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { persistUserPackages } from '../store/storePackages'
import type { EditorState, EditorStore } from '../store/store'
import { shippedAssetBytes, warmShippedAssets } from './shippedAssetCache'
import { bytesToBase64 } from '../../core/parts/partAssets'
import { sameAsBuiltIn } from '../../core/builtInVersion'

/** One part folder as the shell read it (partsWorkspace.cjs readPartFolder). */
interface ShelfFolder {
  dir: string
  id: string
  name: string
  manifestJson: string
  behaviorSource: string
  /** the card image beside the part, as a PNG data URL (partsShelf.cjs) */
  thumbnail?: string
}

interface ShelfScan {
  root: string
  parts: ShelfFolder[]
  problems: { dir: string; message: string }[]
}

/** window.oipShelf (apps/desktop/preload.cjs). */
export interface OipShelfApi {
  list(): Promise<ShelfScan>
  /** the shelf's files by name, size and change time (partsShelf.cjs shelfSignature) */
  signature(): Promise<string>
  write(id: string, manifestJson: string, behaviorSource: string, thumbnail?: string): Promise<string>
  pickFolder(): Promise<ShelfScan | null>
  reveal(): Promise<string>
}

/** The shell's shelf, or null where there is none (the browser). */
export function getShelfApi(): OipShelfApi | null {
  const api = (globalThis as { oipShelf?: OipShelfApi }).oipShelf
  return api ?? null
}

/** The shelf, read: its parts built and checked, and the folders that could not be (said, never dropped silently). */
export interface ShelfListing {
  root: string
  parts: PartPackage[]
  problems: { dir: string; message: string }[]
  /** card images by part id, for the parts that have one on the shelf */
  thumbnails: ReadonlyMap<string, string>
}

// The last read's builds, by folder contents. Building a part runs its script in the sandbox, and the shelf is read
// on every window focus, so a folder whose files have not changed keeps the part built from them. Keeping the same
// object also keeps its cached fingerprint (core/parts/partOrigin.ts).
let builtBefore = new Map<string, PartPackage | { failed: string }>()

/** Build a shelf scan into parts, the way a folder import (Import part > A folder of parts…) builds a folder (packageSource.ts). */
export function shelfListingOf(scan: ShelfScan): ShelfListing {
  const parts: PartPackage[] = []
  const problems = [...scan.problems]
  const thumbnails = new Map<string, string>()
  const built = new Map<string, PartPackage | { failed: string }>()
  for (const folder of scan.parts) {
    const key = `${folder.manifestJson}\0${folder.behaviorSource}`
    let result = builtBefore.get(key)
    if (result === undefined) {
      try {
        const pkg = buildPackage(JSON.parse(folder.manifestJson) as PackageManifest, folder.behaviorSource)
        const bad = validatePartPackage(pkg)
        if (bad.length > 0) throw new Error(bad.map((p) => `${p.field}: ${p.message}`).join('; '))
        result = pkg
      } catch (e) {
        result = { failed: e instanceof Error ? e.message : String(e) }
      }
    }
    built.set(key, result)
    if ('failed' in result) {
      problems.push({ dir: folder.dir, message: result.failed })
      continue
    }
    parts.push(result)
    if (folder.thumbnail?.startsWith('data:image/png;base64,')) thumbnails.set(result.id, folder.thumbnail)
  }
  builtBefore = built
  return { root: scan.root, parts, problems, thumbnails }
}

/** True when two reads of the shelf found the same thing, so the second need not be published. */
export function sameListing(a: ShelfListing, b: ShelfListing): boolean {
  if (a.root !== b.root || a.parts.length !== b.parts.length || a.thumbnails.size !== b.thumbnails.size) return false
  if (a.parts.some((p, i) => p !== b.parts[i])) return false
  for (const [id, image] of a.thumbnails) if (b.thumbnails.get(id) !== image) return false
  return JSON.stringify(a.problems) === JSON.stringify(b.problems)
}

export async function readShelf(api: OipShelfApi): Promise<ShelfListing> {
  return shelfListingOf(await api.list())
}

/** The project's own copy of a part id, if it has one. */
function projectCopy(state: Pick<EditorState, 'userPackages'>, id: string): PartPackage | undefined {
  return state.userPackages.find((p) => p.id === id)
}

/**
 * What a shelf part is to the open project. Two versions of one built-in are the same part with different edits, never
 * two parts sharing an id (and a built-in's copy cannot be renamed apart). So the project's untouched copy, which has no
 * edits to lose, reads as an update, and an edited one as changed in both.
 */
export function statusInProject(state: Pick<EditorState, 'userPackages' | 'bundledPackages'>, shelfPart: PartPackage): ShelfStatus {
  const copy = projectCopy(state, shelfPart.id)
  const status = shelfStatus(copy, shelfPart)
  if (status !== 'sameIdDifferentPart' || copy === undefined) return status
  const builtIn = state.bundledPackages.find((b) => b.id === copy.id)
  if (!builtIn) return status
  return sameAsBuiltIn(copy, builtIn) ? 'updateAvailable' : 'changedInBoth'
}

/**
 * Copy a shelf part into the project's parts (placing it, or updating the project's copy): registered as this
 * project's own, so every placed copy rebuilds on it, and kept with the project like any library part. The caller
 * has asked first where that replaces edits made here ('changedInBoth').
 */
export function copyFromShelf(store: EditorStore, shelfPart: PartPackage): void {
  const copy = asShelfCopy(shelfPart)
  registerPackage(copy, true)
  store.addUserPackage(copy)
}

/** `pkg` with each url asset that names a sha256 this app has the bytes of turned into embedded data (sha256 kept). */
function withShippedBytes(pkg: PartPackage): PartPackage {
  if (!pkg.assets?.some((a) => a.url !== undefined && a.sha256 !== undefined)) return pkg
  const assets = pkg.assets.map((a) => {
    const bytes = a.url !== undefined && a.sha256 !== undefined ? shippedAssetBytes(a.sha256) : undefined
    if (bytes === undefined) return a
    const { url: _url, ...rest } = a
    return { ...rest, data: bytesToBase64(bytes) }
  })
  return { ...pkg, assets }
}

/**
 * Put a project part on the shelf: written over that id's shelf folder with its card image (a PNG data URL, or none),
 * and the project's copy recorded as made from what is now there (so it reads up to date). Returns '' or the error
 * to show.
 */
export async function putOnShelf(store: EditorStore, api: OipShelfApi, part: PartPackage, thumbnail?: string): Promise<string> {
  // a built-in copy's model goes on the shelf as its bytes (a file there, beside the manifest), not as a path into this
  // app: the shelf is shared, and another install may not ship that file
  await warmShippedAssets([part])
  const onShelf = withShippedBytes(forShelf(part))
  const error = await api.write(onShelf.id, JSON.stringify(manifestOfPackage(onShelf), null, 2) + '\n', onShelf.behavior, thumbnail)
  if (error !== '') return error
  const state = store.getState()
  const cur = projectCopy(state, part.id)
  if (cur) {
    // not a part edit (its content is what it was), so no rebuild and no undo step: only the record moves
    const next = onShelfAs(cur)
    store.setState({ userPackages: state.userPackages.map((p) => (p.id === part.id ? next : p)) })
    persistUserPackages(store)
  }
  return ''
}
