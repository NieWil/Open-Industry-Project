// Changing a placed part from a command line (`npm run edit-part`): its params, through the same parsing, type
// check and visibleWhen warnings as add-part (partParamArgs.ts), and its pose, carrying its soft-parented subtree
// the way the editor's gizmo does (hierarchy.ts subtreeIds: a parent moves with its descendants).
//
// Works on the saved scene part, whose params are sparse. An absent param reads as loading reads it
// (scene.ts validateParam: a boolean's `whenAbsent`, else the default), and only what an edit changes is written.

import { descendantIds } from '../scene/hierarchy'
import { packageParamSpecs } from '../packageParams'
import { parseParamArgs, withParamArgs } from './partParamArgs'
import { getPackage } from './partRegistry'
import { createSdkPart } from '../scene/scene'
import type { PartInstance, SdkPart, SdkPartParams } from '../types'

export interface ParamChange {
  key: string
  from: unknown
  to: unknown
  /** the new value is the param's declared default */
  isDefault: boolean
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * `part` (a saved scene part) with `paramsText` (`k=v,...` or a JSON object) applied: the params to store and what
 * changed. Throws an Error naming the bad piece (an unknown key, a value that does not fit its type). A given param
 * its visibleWhen switch hides is pushed onto `warnings`.
 */
export function editPartParams(part: SdkPart, paramsText: string, warnings: string[] = []): { params: SdkPartParams; changes: ParamChange[] } {
  const pkg = getPackage(part.packageId)
  if (!pkg) throw new Error(`params: ${part.packageId} is not registered`)
  // the part as loaded: absent params read as loading reads them (placed: false = a boolean's whenAbsent)
  const loaded = createSdkPart(pkg, part.id, part.position, part.rotationY)
  const base: SdkPart = { ...loaded, params: { ...loaded.params, ...part.params } }
  const next = withParamArgs(base, parseParamArgs(paramsText), warnings)
  const defaults = new Map(packageParamSpecs(pkg).map((s) => [s.key, s.default as unknown]))
  const params: SdkPartParams = { ...part.params }
  const changes: ParamChange[] = []
  for (const [key, to] of Object.entries(next.params)) {
    const from = base.params[key]
    if (same(to, from)) continue
    params[key] = to
    changes.push({ key, from, to, isDefault: defaults.has(key) && same(to, defaults.get(key)) })
  }
  return { params, changes }
}

export interface PoseEdit {
  /** the part's new origin, world metres */
  at?: [number, number, number]
  /** the part's new yaw, radians */
  rotationY?: number
}

/**
 * `parts` with `id` moved/turned to `edit`, its soft-parented descendants carried rigidly (translated by the same
 * delta, and turned about the part's new origin by the same yaw change). Returns the new list and the ids that moved.
 */
export function editPartPose(parts: readonly PartInstance[], id: string, edit: PoseEdit): { parts: PartInstance[]; moved: string[] } {
  const target = parts.find((p) => p.id === id)
  if (!target) throw new Error(`no part "${id}"`)
  const from = target.position
  const to = edit.at ?? from
  const dYaw = edit.rotationY === undefined ? 0 : edit.rotationY - target.rotationY
  const carried = new Set(descendantIds(parts, id))
  const c = Math.cos(dYaw)
  const s = Math.sin(dYaw)
  const moved: string[] = []
  const out = parts.map((p) => {
    if (p.id === id) {
      moved.push(p.id)
      return { ...p, position: [to[0], to[1], to[2]], rotationY: edit.rotationY ?? p.rotationY } as PartInstance
    }
    if (!carried.has(p.id)) return p
    // relative to the old origin, turned by the yaw change (local +X -> (cos, -sin), core/math.ts forwardXZ), then
    // placed against the new origin
    const rx = p.position[0] - from[0]
    const rz = p.position[2] - from[2]
    moved.push(p.id)
    return {
      ...p,
      position: [to[0] + rx * c + rz * s, p.position[1] + (to[1] - from[1]), to[2] - rx * s + rz * c],
      rotationY: p.rotationY + dYaw,
    } as PartInstance
  })
  return { parts: out, moved }
}
