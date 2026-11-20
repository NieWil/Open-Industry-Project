import type { BufferGeometry, Group } from 'three'
import type { PartPackage } from '../../../core/parts/partPackage'
import type { SdkPart } from '../../../core/types'
import { PALLET_SIZE } from '../../../core/types'
import { cargoView } from '../../../core/frame'
import { createPalletGeometry, createPalletMaterial } from '../pallet'
import { shadowMesh } from '../common'
import { createCargoBoxGeometry, createCargoBoxMaterial } from '../cargoBox'
import { createToteGeometry, createToteMaterial } from '../tote'
import { TOTE_SIZE } from '../../../core/tote'
import { bumpStructureVersion } from '../structureRev'
import type { Content } from './types'

// ---- dynamic cargo (geometry.kind: 'cargo') --------------------------------
// C-cargo: the part is a piece of cargo. Placed instances render through the instanced SimBoxes batch
// (core/frame buildAuthoredCargoFrame idle, the sim frame running) and the view hides this scene visual. The mesh
// built here is kept for what the batch cannot do: the placement-staging preview (the staged entry renders this
// visual directly), the catalog thumbnail, and giving the group root the cargo's world transform for
// collision-vertex snap. A 'box' is the cardboard box (cargoBox.ts) scaled
// to the instance's length/height/width and tinted by its color param; a 'pallet' is the wooden pallet (pallet.ts);
// a 'tote' is the plastic tote (tote.ts).

// Every visual of a kind draws one shared geometry (a box scaled per instance, a pallet per footprint, a tote per
// size), held for the session and never freed; only the material is per visual, for its tint.
let boxGeometry: BufferGeometry | null = null
const palletGeometries = new Map<string, BufferGeometry>()
function palletGeometry(length: number, width: number): BufferGeometry {
  const key = `${Math.round(length * 1000)}x${Math.round(width * 1000)}`
  let g = palletGeometries.get(key)
  if (!g) {
    g = createPalletGeometry(length, width)
    palletGeometries.set(key, g)
  }
  return g
}

/** how far the placement preview floats over the floor plane it would otherwise z-fight (see buildCargo) */
const PREVIEW_FLOOR_LIFT = 0.01

const toteGeometries = new Map<string, BufferGeometry>()
function toteGeometry(length: number, height: number, width: number): BufferGeometry {
  const key = `${Math.round(length * 1000)}x${Math.round(height * 1000)}x${Math.round(width * 1000)}`
  let g = toteGeometries.get(key)
  if (!g) {
    g = createToteGeometry(length, height, width)
    toteGeometries.set(key, g)
  }
  return g
}

export function buildCargo(geo: Extract<PartPackage['geometry'], { kind: 'cargo' }>, root: Group): Content {
  const isPallet = geo.cargoKind === 'pallet'
  const isTote = geo.cargoKind === 'tote'
  const material = isPallet ? createPalletMaterial() : isTote ? createToteMaterial() : createCargoBoxMaterial()
  const geometry = isPallet
    ? palletGeometry(PALLET_SIZE[0], PALLET_SIZE[2])
    : isTote ? toteGeometry(TOTE_SIZE[0], TOTE_SIZE[1], TOTE_SIZE[2]) : (boxGeometry ??= createCargoBoxGeometry())
  const mesh = shadowMesh(geometry, material)
  // lift a hair off the floor so the placement preview does not z-fight the coplanar floor (render-only:
  // the hidden placed visual never draws, vsnap reads the footprint)
  mesh.position.y = PREVIEW_FLOOR_LIFT
  root.add(mesh)

  return {
    materials: [material],
    refresh(p: SdkPart): void {
      const view = cargoView(p)
      if (!view) return
      if (isPallet || isTote) {
        // a pallet or a tote is built at its own size; a new size is a different (shared, never freed) geometry
        const [hx, hy, hz] = view.halfExtents
        const g = isPallet ? palletGeometry(hx * 2, hz * 2) : toteGeometry(hx * 2, hy * 2, hz * 2)
        if (mesh.geometry !== g) {
          mesh.geometry = g
          bumpStructureVersion(root) // re-tag a staged preview onto the new geometry (attachMesh)
        }
      } else {
        // a box is the unit cube scaled to the live params
        mesh.scale.set(view.halfExtents[0] * 2, view.halfExtents[1] * 2, view.halfExtents[2] * 2)
      }
      // the tint multiplies the texture (white leaves it as is), like the instanced batch
      material.color.set(view.color)
    },
    dispose(): void {
      material.dispose()
    },
  }
}
