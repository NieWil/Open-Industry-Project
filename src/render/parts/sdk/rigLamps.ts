// Lamp state shared by a rig's own links (rig.ts) and its geometry() submeshes (rigProcedural.ts): the material
// entry a lamp is painted through, the paint itself, and the ease a lamp-driven squash runs at.

import { Color, MeshStandardMaterial } from 'three'
import { LampBank } from '../lampBank'

export const SQUASH_TAU = 0.05 // time constant (s) of the squash ease - a cup settles ~95% in ~0.15 s

// C-emissive lamp-link material entry (see buildRig's lampMats)
// `bank`: a lamp drawn as an instance of a LampBank - painted through the bank's per-instance data, never `mat`
export type LampMat = { name: string; mat: MeshStandardMaterial; color: Color; off: Color; opacity?: number; bank?: { bank: LampBank; index: number } }

// C-emissive: light/darken one lamp link's material (mirrors the built-in stack-light paintLens - lit =
// tint + emissive at full energy, a lamp `opacity` lens going translucent over its core; off = the unlit
// albedo, opaque).
export function paintLamp(lm: LampMat, on: boolean): void {
  if (lm.bank) {
    lm.bank.bank.paint(lm.bank.index, on)
    return
  }
  if (on) {
    lm.mat.color.copy(lm.color)
    lm.mat.emissive.copy(lm.color)
    lm.mat.emissiveIntensity = 1
    if (lm.opacity !== undefined) {
      lm.mat.transparent = true
      lm.mat.opacity = lm.opacity
    }
  } else {
    lm.mat.color.copy(lm.off)
    lm.mat.emissive.setHex(0x000000)
    lm.mat.emissiveIntensity = 0
    if (lm.opacity !== undefined) {
      lm.mat.transparent = false
      lm.mat.opacity = 1
    }
  }
}
