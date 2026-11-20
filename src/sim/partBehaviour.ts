// What a part does when it runs alone: the old-parts corpus's measure (src/sim/partCorpus.test.ts), shared with the
// listed-library corpus (libraryCorpus.test.ts) and the submission checks (scripts/check-submission.mjs).
//
// The part is placed alone in a scene and run for two seconds of sim time. The digest records what it did in units
// coarse enough to be the same on every machine: cargo to the millimetre, joints, lamps, displays and values to the
// thousandth. A part version keeps its digest for good; a later build that makes it behave differently fails.

import type { BoxFrame } from '../core/frame'
import { allPartDiagnostics, clearPartDiagnostics } from '../core/parts/partDiagnostics'
import type { ParamValue } from '../core/parts/partApi'
import type { PartPackage } from '../core/parts/partPackage'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { validateScene } from '../core/scene/scene'
import { sha256Hex } from '../core/sha256'
import { SCENE_VERSION } from '../core/types'
import { SimWorld } from './world'
import type { JoltModule } from './world'

/** Steps a part runs alone: two seconds at the default 60 Hz. */
export const PART_BEHAVIOUR_STEPS = 120

/** A digest of what a frame shows, the same on every machine. */
export function behaviourDigest(f: BoxFrame): string {
  const r3 = (n: number): number => Math.round(n * 1000)
  const sorted = (o: Record<string, Record<string, unknown>> | undefined): [string, [string, unknown][]][] =>
    Object.entries(o ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, x]) => [n, typeof x === 'number' ? r3(x) : x])])
  const cargo = Array.from({ length: f.count }, (_, i) => [f.kinds[i], r3(f.positions[i * 3]!), r3(f.positions[i * 3 + 1]!), r3(f.positions[i * 3 + 2]!)])
  const facts = { cargo, joints: sorted(f.joints), lamps: sorted(f.lamps), displays: sorted(f.displays), values: sorted(f.values) }
  return sha256Hex(JSON.stringify(facts)).slice(0, 16)
}

/**
 * Run `pkg` alone and say what it did. `others` are the parts it may name (held cargo, a unit load's pieces),
 * registered first; `pkg` is registered last, over its own id. `params` are the placed part's overrides. The registry
 * and the part diagnostics are cleared before and after.
 */
export function runPartAlone(
  Jolt: JoltModule,
  pkg: PartPackage,
  opts: { others?: readonly PartPackage[]; params?: Record<string, ParamValue>; steps?: number } = {},
): { digest: string; problems: string[] } {
  clearPackages()
  clearPartDiagnostics()
  let world: SimWorld | null = null
  try {
    for (const p of opts.others ?? []) registerPackage(p, true)
    registerPackage(pkg, true)
    const scene = validateScene(
      { version: SCENE_VERSION, parts: [{ id: 'p', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0, params: opts.params ?? {} }], packages: [pkg] },
      new Set([pkg.id]),
    )
    if (!scene.ok) return { digest: '', problems: [`the scene would not validate: ${scene.errors.join('; ')}`] }
    world = new SimWorld(Jolt, scene.scene)
    for (let i = 0; i < (opts.steps ?? PART_BEHAVIOUR_STEPS); i++) world.step()
    const problems = allPartDiagnostics()
      .filter((d) => d.partId === 'p' || d.packageId === pkg.id)
      .map((d) => `${d.source}: ${d.message}`)
    return { digest: behaviourDigest(world.frame()), problems }
  } finally {
    world?.dispose()
    clearPackages()
    clearPartDiagnostics()
  }
}
