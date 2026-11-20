// Deletion gate: no shipped scene may embed a retired built-in part.
//
// Every equipment part is an SDK package (docs/architecture.md), so PART_DEFS holds only the keep-forever
// types (the container Group, the warehouse Building shell, the generic custom/part wrapper) and the
// RETIRED set is empty: a re-added built-in PartType fails the build here. The per-scene checks assert no
// shipped scene embeds a retired type, a guard if one is ever reintroduced.
//
// The RETIRED set is derived from PART_DEFS (every noCatalog type minus the keep-forever container/shell/
// generic types), so there is no hardcoded list to drift.

import { describe, expect, it } from 'vitest'
import { PART_DEFS, SCENE_VERSION } from '../core/types'
import type { PartInstance, PartType, SceneJSON } from '../core/types'
import { emptyScene } from '../core/scene/scene'
import { createPlcDemoScene, defaultBuilding } from './demo/demoScenes'

// Kept forever - no rig+behavior SDK equivalent: the pure-container Group node, the warehouse Building
// shell, the generic `custom` wrapper (only renamed to `part` at deletion time, never removed), and the
// Annotation note.
//
// `annotation` is here for the same reason `group` is: it is a meta type, not a piece of equipment, and that
// distinction is what this gate protects. An SDK part is geometry + behavior, and a note has neither (no mesh,
// no body, no tick), so there is nothing for a package to hold. What this gate forbids is a conveyor or a
// sensor coming back as engine code after being re-authored on the SDK. Adding a meta type beside Group is
// not that. If a future entry here could plausibly be a package, it belongs in a package.
const KEEP: ReadonlySet<PartType> = new Set<PartType>(['group', 'part', 'building', 'annotation'])
const RETIRED = (Object.keys(PART_DEFS) as PartType[]).filter((t) => PART_DEFS[t].noCatalog && !KEEP.has(t))
const RETIRED_SET = new Set<string>(RETIRED)

/** the New/default scene: just the warehouse shell (mirrors main.tsx defaultScene) */
const defaultScene = (): SceneJSON => ({ version: SCENE_VERSION, parts: [defaultBuilding()] })

const SHIPPED_SCENES: ReadonlyArray<readonly [string, () => SceneJSON]> = [
  ['PLC sortation demo (?scene=demo)', createPlcDemoScene],
  ['default New scene', defaultScene],
  ['empty scene', emptyScene],
]

const retiredParts = (scene: SceneJSON): PartInstance[] => scene.parts.filter((p) => RETIRED_SET.has(p.type))

describe('retired built-ins are absent from every shipped scene (deletion gate)', () => {
  it('retirement is complete - PART_DEFS holds only the keep-forever types (no retired built-in remains)', () => {
    expect(RETIRED).toEqual([]) // every in-scope built-in is code-deleted; box/pallet were the last
    // guards against a built-in PartType creeping back in: every remaining PART_DEF must be keep-forever.
    for (const t of Object.keys(PART_DEFS) as PartType[]) {
      expect(KEEP.has(t), `${t} is not a keep-forever type - a retired built-in was reintroduced`).toBe(true)
    }
  })

  for (const [name, build] of SHIPPED_SCENES) {
    it(`${name} embeds no retired built-in part`, () => {
      // report the offending type + id, not just a length, so a failure names what to migrate
      expect(retiredParts(build()).map((p) => `${p.type} (${p.id})`)).toEqual([])
    })
  }
})
