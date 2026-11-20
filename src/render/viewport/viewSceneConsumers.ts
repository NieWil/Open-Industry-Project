// Scene-change consumers: the view's reactions to an edit, each declaring which parts it reads so a sync that
// touches none of them skips it, and each carrying an idle audit against a from-scratch derivation. The design and
// the rules for adding one: docs/scene-change-consumers.md.

import { deltaTouches } from '../../core/scene/sceneDelta'
import type { SceneDelta } from '../../core/scene/sceneDelta'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance } from '../../core/types'
import type { MergeCoherenceCheck } from './viewTypes'

export interface SceneConsumer {
  readonly name: string
  /**
   * The parts this consumer's output depends on, checked against the version of each changed part before and after
   * the edit. `'self'` is only for a consumer that memoizes on its own input at O(cheap compare) per part, where a
   * predicate cannot say what it reads (the idle cargo frame: hiding a group changes which cargo it draws without
   * touching any cargo part). Say why at the registration.
   */
  readonly reads: ((p: PartInstance) => boolean) | 'self'
  /** react to a delta that touches what it reads */
  apply(delta: SceneDelta): void
  /**
   * Idle check: does the retained output equal what a from-scratch derivation gives now? With it, a too-narrow
   * `reads` fails a gate instead of leaving stale pixels. Never call it mid-drag.
   */
  audit(): { ok: boolean; reason: string }
}

/** The view's scene-change consumers, run in registration order after each sync's entries are updated. */
export class SceneConsumers {
  private readonly list: SceneConsumer[] = []
  /** what the last sync changed (diagnostics) */
  lastDelta: SceneDelta | null = null
  /** the package registry revision the last sync saw: a package edit changes parts under unchanged references */
  syncedRegistryRev = -1
  /** syncs that ran / skipped each consumer (viewSceneConsumers.test.ts and diagnostics read it) */
  readonly counts = new Map<string, { ran: number; skipped: number }>()

  register(c: SceneConsumer): void {
    this.list.push(c)
    this.counts.set(c.name, { ran: 0, skipped: 0 })
  }

  run(delta: SceneDelta): void {
    this.lastDelta = delta
    for (const c of this.list) {
      const n = this.counts.get(c.name)!
      if (c.reads === 'self' || deltaTouches(delta, c.reads)) {
        c.apply(delta)
        n.ran++
      } else {
        n.skipped++
      }
    }
  }

  audit(): MergeCoherenceCheck[] {
    return this.list.map((c) => ({ name: `sceneConsumer:${c.name}`, ...c.audit() }))
  }
}

// whether a package draws a sensor beam (a rig link with `beam`): the parts the stopped beam probe reads. Cached per
// package object, so a package edit (a new object) is checked again.
const beamPackages = new WeakMap<PartPackage, boolean>()
export function drawsSensorBeam(p: PartInstance): boolean {
  if (p.type !== 'part') return false
  const pkg = getPackage(p.packageId)
  if (!pkg) return false
  let has = beamPackages.get(pkg)
  if (has === undefined) {
    has = pkg.geometry.kind === 'rig' && pkg.geometry.links.some((l) => l.beam !== undefined)
    beamPackages.set(pkg, has)
  }
  return has
}
