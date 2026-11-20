// The instanced-batch geometry of a cargo part with its own body (docs/cargo-bodies.md, core/cargoBody.ts): the part's
// own visual, built once per shape, baked into part-local space and merged per material, so every body of that shape
// draws in one instanced mesh per material, as boxes, pallets and totes do.
//
// The visual is built twice, with the part's colour param set white and then black. A material whose colour differs
// between the two is the one the colour tints: its batch takes each body's colour per instance (instanceColor), and is
// built white so the tint is the colour itself. Every other material keeps its own colour and draws untinted.
//
// The visuals are kept, never added to the scene, because a GLB model loads after them: when one's structure version
// moves (structureRev.ts), the caller rebuilds the pieces.

import { BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, Mesh } from 'three'
import type { Material, Object3D } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { CargoShapeRef } from '../../core/frame'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import type { PartVisual } from './registry'
import { createCustomVisual } from './sdkPart'

/** One material's share of a part's visual, merged: what one instanced batch draws. */
export interface PartCargoPiece {
  geometry: BufferGeometry
  material: Material
  /** the cargo's colour tints it (per instance); otherwise it draws in its own colour */
  tinted: boolean
}

/** A built shape: its pieces, and the visuals they came from (kept so a late-loading model can be noticed). */
export interface PartCargoMesh {
  pieces: PartCargoPiece[]
  /** the visual whose structure version the caller watches */
  visual: PartVisual
  /** the white/black twin used to tell tinted materials apart; watched with the visual */
  twin: PartVisual
  /** the visual's structure version when the pieces were built */
  rev: number
  /** the twin's, likewise: its model can land after the visual's */
  twinRev: number
}

const tmp = new Matrix4()

/** the instance a shape's visual is built from: the body's part at the origin, its colour param set to `color` */
function partAt(ref: CargoShapeRef, colorParam: string, color: string): PartInstance {
  return { id: '__cargo_batch', type: 'part', packageId: ref.packageId, position: [0, 0, 0], rotationY: 0, params: { ...ref.params, [colorParam]: color } } as PartInstance
}

function visualAt(ref: CargoShapeRef, colorParam: string, color: string): PartVisual {
  return createCustomVisual(partAt(ref, colorParam, color))
}

/**
 * Every drawn mesh under `root` with its part-local matrix (an instanced bank as one entry per instance). A hidden
 * link hides its group, not its meshes, so the walk skips invisible subtrees: a hidden collider box would otherwise
 * be drawn over the model.
 */
function drawn(root: Object3D): { mesh: Mesh; matrix: Matrix4 }[] {
  root.updateMatrixWorld(true)
  const out: { mesh: Mesh; matrix: Matrix4 }[] = []
  root.traverseVisible((o) => {
    if (!(o as Mesh).isMesh) return
    const mesh = o as Mesh
    if ((mesh as InstancedMesh).isInstancedMesh) {
      const im = mesh as InstancedMesh
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, tmp)
        out.push({ mesh, matrix: new Matrix4().multiplyMatrices(mesh.matrixWorld, tmp) })
      }
    } else out.push({ mesh, matrix: mesh.matrixWorld.clone() })
  })
  return out
}

/**
 * A geometry (or one material group of it) reduced to position, normal and uv, unindexed and baked through `matrix`,
 * so any two merge. Every attribute is copied out as floats first. A model's can be normalized integers (a quantized
 * GLB) or interleaved: baking a matrix into those in place wraps every coordinate past ±1, and two attributes of
 * different array types refuse to merge, which dropped the piece.
 */
export function bakedCargoGeometry(source: BufferGeometry, matrix: Matrix4, group?: { start: number; count: number }): BufferGeometry {
  const index = source.index
  const position = source.getAttribute('position')
  const total = !position ? 0 : index ? index.count : position.count
  const start = group ? group.start : 0
  const count = Math.max(0, group ? Math.min(group.count, total - start) : total)
  const out = new BufferGeometry()
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = source.getAttribute(name)
    if (!a) continue
    const arr = new Float32Array(count * a.itemSize)
    for (let i = 0; i < count; i++) {
      const v = index ? index.getX(start + i) : start + i
      for (let j = 0; j < a.itemSize; j++) arr[i * a.itemSize + j] = a.getComponent(v, j)
    }
    out.setAttribute(name, new BufferAttribute(arr, a.itemSize))
  }
  if (!out.getAttribute('position')) out.setAttribute('position', new BufferAttribute(new Float32Array(0), 3))
  if (!out.getAttribute('uv')) out.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2))
  out.applyMatrix4(matrix)
  if (!out.getAttribute('normal')) out.computeVertexNormals()
  return out
}

/** The colour a material shows, as a comparable string, or '' when it has none. */
const colorOf = (m: Material): string => ((m as { color?: { getHexString(): string } }).color?.getHexString() ?? '')

const revOf = (v: PartVisual): number => (v.object.userData.structureVersion as number) ?? 0

/** Build the batch pieces of a cargo shape, or null when its part is not in the registry. */
export function buildPartCargoMesh(ref: CargoShapeRef): PartCargoMesh | null {
  const pkg = getPackage(ref.packageId)
  if (!pkg) return null
  const colorParam = pkg.cargo?.colorParam ?? 'color'
  return piecesFrom(visualAt(ref, colorParam, '#ffffff'), visualAt(ref, colorParam, '#000000'))
}

/**
 * Build the pieces again from the visuals a stale shape kept, now that its model has loaded into them. New visuals
 * would start the model's load over and finish it only after this build reads them, so they would never draw it.
 */
export function rebuildPartCargoMesh(m: PartCargoMesh): PartCargoMesh {
  return piecesFrom(m.visual, m.twin)
}

function piecesFrom(visual: PartVisual, twin: PartVisual): PartCargoMesh {
  const white = drawn(visual.object)
  const black = drawn(twin.object)
  // material -> its geometries, and whether the colour moved it (the same structure: walked in the same order)
  const byMaterial = new Map<Material, { geos: BufferGeometry[]; tinted: boolean }>()
  white.forEach(({ mesh, matrix }, i) => {
    const other = black[i]?.mesh
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const otherMats = other ? (Array.isArray(other.material) ? other.material : [other.material]) : []
    mats.forEach((m, k) => {
      if (!m) return
      // a multi-material mesh draws each material over its own index group
      const grp = Array.isArray(mesh.material) ? mesh.geometry.groups.find((gr) => (gr.materialIndex ?? 0) === k) : undefined
      if (Array.isArray(mesh.material) && !grp) return
      const entry = byMaterial.get(m) ?? { geos: [], tinted: false }
      entry.geos.push(bakedCargoGeometry(mesh.geometry, matrix, grp))
      const om = otherMats[k]
      if (om && colorOf(om) !== colorOf(m)) entry.tinted = true
      byMaterial.set(m, entry)
    })
  })
  const pieces: PartCargoPiece[] = []
  for (const [material, { geos, tinted }] of byMaterial) {
    const merged = mergeGeometries(geos, false)
    for (const g of geos) g.dispose() // copies made here, never drawn
    if (!merged) continue
    merged.computeBoundingBox()
    merged.computeBoundingSphere()
    pieces.push({ geometry: merged, material: material.clone(), tinted })
  }
  return { pieces, visual, twin, rev: revOf(visual), twinRev: revOf(twin) }
}

/** Has a model loaded into either visual since the pieces were built (the pieces should be rebuilt)? */
export function partCargoMeshStale(m: PartCargoMesh): boolean {
  return revOf(m.visual) !== m.rev || revOf(m.twin) !== m.twinRev
}

/**
 * The shape's package changed in the registry (a Part Editor edit, a hot reload): apply the kept visuals again, as
 * the scene's own visuals are (view.refreshPackage), and leave the pieces stale so the caller rebuilds them. `ref` is
 * the shape as the frame now names it, whose params are resolved against the changed package. An edit that keeps the
 * colliders keeps the shape's key, so nothing else would ever replace these visuals.
 */
export function refreshPartCargoVisuals(m: PartCargoMesh, ref: CargoShapeRef): void {
  const pkg = getPackage(ref.packageId)
  if (!pkg) return
  const colorParam = pkg.cargo?.colorParam ?? 'color'
  m.visual.update(partAt(ref, colorParam, '#ffffff'))
  m.twin.update(partAt(ref, colorParam, '#000000'))
  // stale whether or not the update rebuilt a visual: a repaint in place moves no structure version, and the pieces
  // draw clones of the materials
  m.rev = -1
}

/** Drop the visuals a built shape kept (never drawn, so disposed directly). The pieces are the caller's. */
export function disposePartCargoVisuals(m: PartCargoMesh): void {
  m.visual.dispose()
  m.twin.dispose()
}
