// A drop of files or folders that makes a part, wherever it lands.
//
// The Parts dock imports them (components/Catalog.tsx): it owns the follow-up choices a robot can need. A drop on the
// viewport that is not just part files is handed to the dock through here, so there is one importer.
import { isModelFile, isRobotArchive, isUrdfFile } from './modelPartImport'

export interface PartDrop {
  files: File[]
  /** dropped folders, each read as a robot's folder */
  dirs: FileSystemEntry[]
  /** the screen point of the drop, where a follow-up choice opens */
  at: { x: number; y: number }
}

/** What a drop holds. A folder's entries can only be read during the drop event, so this is called in the handler. */
export function readPartDrop(e: { dataTransfer: DataTransfer; clientX: number; clientY: number }): PartDrop {
  const entries = Array.from(e.dataTransfer.items ?? [], (item) => item.webkitGetAsEntry?.() ?? null)
  return {
    files: Array.from(e.dataTransfer.files),
    dirs: entries.filter((entry): entry is FileSystemEntry => entry?.isDirectory === true),
    at: { x: e.clientX, y: e.clientY },
  }
}

/** whether the drop holds something the Parts dock makes a new part from: a model, a robot description, a robot's
 *  .zip or a folder */
const dropMakesPart = (drop: PartDrop): boolean =>
  drop.dirs.length > 0 || drop.files.some((f) => isModelFile(f.name) || isUrdfFile(f.name) || isRobotArchive(f.name))

// One drop waits at a time, for a dock that is still mounting; a later one replaces it.
let waiting: PartDrop | null = null
let notify: (() => void) | null = null

/** Hand a drop that makes a new part to the Parts dock, which takes it when it is there. False, and nothing is
 *  handed over, when the drop holds no such thing; on true the caller reveals the dock. */
export function handToPartsDock(drop: PartDrop): boolean {
  if (!dropMakesPart(drop)) return false
  waiting = drop
  notify?.()
  return true
}

/** The Parts dock's side: `take` is called for a waiting drop now and for each one handed over later. */
export function receivePartDrops(take: (drop: PartDrop) => void): () => void {
  const deliver = (): void => {
    const drop = waiting
    waiting = null
    if (drop) take(drop)
  }
  notify = deliver
  deliver()
  return () => {
    if (notify === deliver) notify = null
  }
}
