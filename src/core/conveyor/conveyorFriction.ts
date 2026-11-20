// A conveyor's running-surface friction. The friction param a conveyor declares (ConveyorDecl `frictionParam`) is
// the friction between the surface and a standard carton, the figure a belt datasheet quotes. Jolt gives each body a
// friction of its own and combines a pair as sqrt(a * b), so the surface's own value is the one that makes that pair
// come out as typed: mu^2 / BOX_FRICTION. Other cargo then grips by its own friction against the same surface.

import type { PartPackage } from '../parts/partPackage'
import { getPackage } from '../parts/partRegistry'
import { resolvedParam } from '../parts/partScript'
import type { PartInstance } from '../types'
import { BELT_FRICTION, BOX_FRICTION, CONVEYOR_FRICTION } from '../types'

/** the surface friction that gives `carton` against a standard carton (BOX_FRICTION) */
export function surfaceFrictionFromCarton(carton: number): number {
  return (carton * carton) / BOX_FRICTION
}

/** a surface friction's grip against a standard carton: the inverse of surfaceFrictionFromCarton */
export function cartonFrictionOf(surface: number): number {
  return Math.sqrt(surface * BOX_FRICTION)
}

/** the friction of a declared surface kind: a belt grips like the built-in belt, anything else (a roller bed, or a
 *  conveying part that declares nothing) like a roller bed */
export function declaredSurfaceFriction(pkg: PartPackage | undefined): number {
  return pkg?.conveyor?.surface === 'belt' ? BELT_FRICTION : CONVEYOR_FRICTION
}

/**
 * The surface friction a conveying part's bodies get: its declared friction param's value (the instance's, else the
 * param's default) converted from carton friction, else its declared surface kind's. A negative or non-finite value
 * reads as the surface kind's, so a hand-edited project can't build a body Jolt rejects.
 */
export function conveyorSurfaceFriction(part: PartInstance): number {
  return packageSurfaceFriction(part.type === 'part' ? getPackage(part.packageId) : undefined, part.params as Record<string, unknown>)
}

/** conveyorSurfaceFriction for a package and an instance's param overrides */
export function packageSurfaceFriction(pkg: PartPackage | undefined, params: Readonly<Record<string, unknown>>): number {
  const key = pkg?.conveyor?.frictionParam
  if (key) {
    const v = resolvedParam(pkg.params, params, key)
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return surfaceFrictionFromCarton(v)
  }
  return declaredSurfaceFriction(pkg)
}
