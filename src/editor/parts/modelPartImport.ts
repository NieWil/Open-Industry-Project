// A new part made from a model file (.glb, STEP, USD), from Import part or a drop on the Parts dock.
//
// The part is made as New part makes one, named after the file, and opened as its own scene with its one node
// selected. The file is handed to that node's panel (inspector/rigNode.tsx), which converts it with the options
// it shows for any model; the import then fits the part to the model (core/parts/modelFit.ts). So there is one
// place a model is converted, whichever way it came in.
import type { EditorController } from '../controller'

export const isModelFile = (name: string): boolean => /\.(glb|step|stp|usd|usda|usdc|usdz)$/i.test(name)

/** a robot description: URDF, or xacro that expands to it; kept here, beside isModelFile, so the Parts dock can tell
 *  one without loading the importer */
export const isUrdfFile = (name: string): boolean => /\.(urdf|xacro)$/i.test(name)

/** a robot's folder as one file: a .zip holding its description and meshes */
export const isRobotArchive = (name: string): boolean => /\.zip$/i.test(name)

/** what Import part's file picker takes besides part files */
export const MODEL_ACCEPT = '.glb,.step,.stp,.usd,.usda,.usdc,.usdz,model/gltf-binary'

/** The file waiting for the node panel of the part it was opened for. One at a time: opening a part replaces it. */
let pending: { packageId: string; file: File } | null = null

/** A part's name from a model file's: no extension, separators as spaces ("crate_black_a02.usd" -> "crate black a02"). */
export function partNameFromFile(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return base || name
}

/**
 * Make a new part for `file` and open it, its node panel showing the file's import options. Returns the part's id,
 * or null when no part can be made here (a read-only view, where New part is refused too).
 */
export function newPartFromModel(controller: EditorController, file: File): string | null {
  const packageId = controller.createBlankPart()
  if (!packageId) return null
  controller.setPartInfo(packageId, { name: partNameFromFile(file.name) })
  pending = { packageId, file }
  return packageId
}

/** The model file waiting for `packageId`'s node panel, taken once. */
export function takePendingModel(packageId: string): File | null {
  if (pending?.packageId !== packageId) return null
  const { file } = pending
  pending = null
  return file
}
