import { Mesh, MeshStandardMaterial } from 'three'
import type { Group } from 'three'
import { getPackage } from '../../../core/parts/partRegistry'
import type { PartPackage } from '../../../core/parts/partPackage'
import type { SdkPart } from '../../../core/types'
import { createDeckSurface, shadowMesh, unitBox } from '../common'
import type { Content } from './types'
import { DEFAULT_DECK_THICK } from './shared'

// ---- deck ----------------------------------------------------------------

const FALLBACK = { length: 1, width: 1, thick: DEFAULT_DECK_THICK }

// The placeholder a part shows while its package has not loaded. Package format 4 has no geometry kind 'deck';
// a stored one loads as the equivalent rig (partUpgrade.ts deckRig).
function deckDims(_pkg: PartPackage | undefined): { length: number; width: number; thick: number } {
  return { length: FALLBACK.length, width: FALLBACK.width, thick: FALLBACK.thick }
}

export function buildDeck(root: Group): Content {
  const deckSurface = createDeckSurface()
  const accentMat = new MeshStandardMaterial({ color: 0xf2bd0f, metalness: 0.1, roughness: 0.5 })
  const deck = shadowMesh(unitBox, deckSurface.material)
  const accent = new Mesh(unitBox, accentMat)
  accent.castShadow = false
  accent.receiveShadow = true
  root.add(deck, accent)
  return {
    materials: [deckSurface.material, accentMat],
    refresh(p: SdkPart): void {
      const { length, width, thick } = deckDims(getPackage(p.packageId))
      deckSurface.setExtent(length, width)
      deck.scale.set(length, thick, width)
      deck.position.y = -thick / 2 // top face at the origin, like the sim body
      const barLen = Math.max(length * 0.07, 0.06)
      accent.scale.set(barLen, 0.012, Math.max(width * 0.8, 0.05))
      accent.position.set(length / 2 - barLen, 0.008, 0)
    },
    dispose(): void {
      deckSurface.dispose()
      accentMat.dispose()
    },
  }
}
