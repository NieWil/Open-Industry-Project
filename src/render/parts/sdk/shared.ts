// Constants + tiny helpers shared by more than one SDK geometry builder. Each lives here exactly
// once so every builder sees the same instance/value.
import { DoubleSide, MeshStandardMaterial } from 'three'
import type { MeshDescription } from '../../../core/parts/partApi'

// ---- shared constants & helpers -------------------------------------------

export const DEFAULT_DECK_THICK = 0.1

// neutral fallback for a roleless / 'mesh' function part that names no material
export const FN_NEUTRAL = () => new MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.1, roughness: 0.8, side: DoubleSide })

function numArrEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
// Two mesh descriptions realize to identical geometry iff their raw arrays match. A full compare is O(verts)
// with no allocation, far cheaper than realizeMeshDescription (BufferGeometry alloc + computeVertexNormals +
// GPU upload), which it lets the roles a param edit didn't touch skip.
export function descEqual(a: MeshDescription, b: MeshDescription): boolean {
  return numArrEqual(a.positions, b.positions) && numArrEqual(a.indices, b.indices) && numArrEqual(a.uvs, b.uvs)
}
