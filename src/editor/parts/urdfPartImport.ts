// A new part made from a URDF or xacro robot, from Import part > A robot (unzipped folder)…, or from a description file,
// a .zip of the robot's folder or the folder itself picked in Import part or dropped on the Parts dock.
//
// The robot is converted at once (editor/urdfImport.ts): unlike a model, it has no options to show, since its links,
// joints and placement are all in the file. A xacro description may have arguments that change the robot: a model to
// pick, or an on/off one such as a hand; the caller asks about those first. The part is then made as New part makes one and opened as its own scene,
// with the teach gizmo on its joints. Anything imported other than as written is reported in one message.

import type { EditorController } from '../controller'
import { defineMessages, t } from '../../core/i18n'
import { UrdfError } from '../../core/urdf'
import { XacroError, xacroArgChoices } from '../../core/xacro'
import type { UrdfRigNote } from '../../core/urdfRig'
import { importUrdf, readRobotDescription, urdfCandidates, URDF_TRIANGLE_BUDGET, type UrdfImport } from '../urdfImport'
import { largeModelAdvisory } from './modelStorage'

const M = defineMessages('urdfImport', {
  noUrdf: 'The folder {name} has no robot description (.urdf, or a .xacro that builds a robot).',
  noUrdfZip: '{name} has no robot description (.urdf, or a .xacro that builds a robot).',
  zipTooBig: '{name} unpacks to more than {mb} MB, so it was not read.',
  zipUnreadable: '{name} could not be read as a zip archive.',
  xacroFailed: 'Could not expand {file}: {reason}',
  xacroPackage: 'Could not expand {file}: {reason}. Pick a folder that holds every package it uses, such as the repository it came from.',
  notUrdf: '{file} is not a URDF robot description: {reason}',
  failed: 'Could not import {file}: {reason}',
  imported: { one: 'Imported {name}: {links} links and {count} joint.', other: 'Imported {name}: {links} links and {count} joints.' },
  missing: {
    one: '{count} mesh file was not found, so its geometry is left out: {first}. Import the folder that holds the robot\'s meshes as well (Import part > A robot (unzipped folder)…), or a .zip of it.',
    other:
      '{count} mesh files were not found, so their geometry is left out, for example {first}. Import the folder that holds the robot\'s meshes as well (Import part > A robot (unzipped folder)…), or a .zip of it.',
  },
  unreadable: {
    one: '{count} mesh file could not be read: {first}. STL, COLLADA (.dae) and OBJ files are read.',
    other: '{count} mesh files could not be read, for example {first}. STL, COLLADA (.dae) and OBJ files are read.',
  },
  simplified: 'Its meshes had {source}k triangles, more than a simulation needs, so they were simplified to {kept}k.',
  noteSecondParent: 'Link {subject} is the child of more than one joint; the first one places it.',
  noteUnknownLink: 'Joint {subject} names a link the file does not have, so it was left out.',
  noteFixedInPlace: 'Joint {subject} is floating or planar, which a part cannot move, so its link stays where it was described.',
  noteNoLimit: 'Joint {subject} has no usable limits, so it turns ±180° (or slides ±1 m).',
  noteMimic: 'Joint {subject} follows a joint that is missing, fixed or following another itself, so here it moves on its own.',
})

const NOTE: Record<UrdfRigNote['code'], (typeof M)[keyof typeof M]> = {
  'second-parent': M.noteSecondParent,
  'unknown-link': M.noteUnknownLink,
  'fixed-in-place': M.noteFixedInPlace,
  'no-limit': M.noteNoLimit,
  mimic: M.noteMimic,
}

/** The robot descriptions a picked folder could import (URDF, or xacro that builds a robot), nearest the top first;
 *  the caller asks which when there are several. */
export function urdfRootsOf(files: ReadonlyMap<string, Blob>): Promise<string[]> {
  return urdfCandidates(files)
}

/** A picked folder's files keyed by their path inside the pick (webkitRelativePath), as the importer resolves them. */
export function folderFiles(list: FileList | readonly File[]): Map<string, Blob> {
  return new Map(Array.from(list).map((f) => [(f.webkitRelativePath || f.name).replaceAll('\\', '/'), f]))
}

/** The most a robot archive may unpack to. A zip's unpacked size is not bounded by its own, and it is all held in
 *  memory; the agent's import reads the same amount from disk (apps/desktop/mcpServer.cjs). */
export const ROBOT_ARCHIVE_MAX_BYTES = 200 * 1024 * 1024

/** A .zip of a robot's folder as the files a picked folder gives, keyed by their path in the archive, or the
 *  message to show when it cannot be read. */
export async function zipFiles(zip: File): Promise<{ files: Map<string, Blob> } | { error: string }> {
  const { unzipSync } = await import('fflate')
  let total = 0
  let tooBig = false
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await zip.arrayBuffer()), {
      // decided from the directory's sizes, before anything is unpacked
      filter: (f) => {
        if (tooBig || f.name.endsWith('/')) return false
        total += f.originalSize
        tooBig = total > ROBOT_ARCHIVE_MAX_BYTES
        return !tooBig
      },
    })
  } catch {
    return { error: t(M.zipUnreadable, { name: zip.name }) }
  }
  if (tooBig) return { error: t(M.zipTooBig, { name: zip.name, mb: ROBOT_ARCHIVE_MAX_BYTES / 1024 / 1024 }) }
  const files = new Map<string, Blob>()
  for (const [path, bytes] of Object.entries(entries)) files.set(path.replaceAll('\\', '/'), new Blob([bytes as Uint8Array<ArrayBuffer>]))
  return { files }
}

/** The files under dropped folders (a drop's directory entries), keyed as a picked folder's are: the folder's name,
 *  then the path inside it. */
export async function droppedFolderFiles(dirs: readonly FileSystemEntry[]): Promise<Map<string, Blob>> {
  const files = new Map<string, Blob>()
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      files.set(entry.fullPath.replace(/^\//, ''), file)
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // a read returns a batch, and an empty one ends the folder
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) return
      for (const child of batch) await walk(child)
    }
  }
  for (const dir of dirs) await walk(dir)
  return files
}

/**
 * Import the robot whose description is `root` (a key of `files`; a xacro file is expanded with `args`) as a new part
 * and open it. Returns the part's id (null when nothing was made) and the message to show, or '' when the import went
 * as written. Nothing is made, and the caller asks and imports again, when a xacro argument names a model the folder
 * lacks (`choose`: the values it can take), or when `ask` is set and the description has on/off arguments that change
 * the robot (`switches`, with their values).
 */
export async function newPartFromUrdf(
  controller: EditorController,
  files: ReadonlyMap<string, Blob>,
  root: string,
  args: Readonly<Record<string, string>> = {},
  ask = false,
): Promise<{ packageId: string | null; message: string; choose?: { arg: string; value: string; choices: string[] }; switches?: Record<string, boolean> }> {
  const file = root.split('/').pop() ?? root
  let result: UrdfImport
  try {
    if (ask) {
      const { switches } = await readRobotDescription(files, root, args)
      if (Object.keys(switches).length > 0) return { packageId: null, message: '', switches }
    }
    result = await importUrdf(files, root, args)
  } catch (e) {
    if (e instanceof XacroError) {
      // an argument names a model the folder lacks (UR's ur_type defaults to none on purpose): ask which
      const choose = xacroArgChoices(e, [...files.keys()])
      if (choose) return { packageId: null, message: '', choose }
      return { packageId: null, message: t(e.code === 'missing-package' ? M.xacroPackage : M.xacroFailed, { file, reason: e.message }) }
    }
    if (e instanceof UrdfError) return { packageId: null, message: t(M.notUrdf, { file, reason: e.message }) }
    return { packageId: null, message: t(M.failed, { file, reason: (e as Error).message }) }
  }
  const packageId = controller.createBlankPart({
    name: result.name,
    geometry: result.geometry,
    assets: result.assets,
    materials: result.materials,
    ...(result.behavior ? { behavior: result.behavior } : {}),
  })
  return { packageId, message: packageId ? summary(result) : '' }
}

/** What the user should know about an import: everything that differs from the file, and nothing when nothing does. */
function summary(r: UrdfImport): string {
  const lines: string[] = []
  if (r.missing.length) lines.push(t(M.missing, { count: r.missing.length, first: r.missing[0]! }))
  if (r.unreadable.length) lines.push(t(M.unreadable, { count: r.unreadable.length, first: r.unreadable[0]! }))
  if (r.stats.sourceTriangles > URDF_TRIANGLE_BUDGET)
    lines.push(t(M.simplified, { source: Math.round(r.stats.sourceTriangles / 1000), kept: Math.round(r.stats.triangles / 1000) }))
  const storage = largeModelAdvisory(r.stats.glbBytes)
  if (storage) lines.push(storage)
  for (const n of r.notes) lines.push(t(NOTE[n.code], { subject: n.subject }))
  if (lines.length === 0) return ''
  return [t(M.imported, { name: r.name, links: r.stats.links, count: r.stats.joints }), ...lines].join('\n\n')
}

/** The message for a picked folder with no URDF in it. */
export const noUrdfMessage = (folder: string): string => t(M.noUrdf, { name: folder })

/** The message for a zip with no URDF in it. */
export const noUrdfZipMessage = (file: string): string => t(M.noUrdfZip, { name: file })
