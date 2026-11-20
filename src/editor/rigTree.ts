// Shared helpers for presenting a custom part's rig (its link/joint hierarchy) in the editor UI: the
// Scene Tree shows it as expandable child nodes (its scene-tree internals), and the Inspector shows
// the joint table. Both resolve the part's package from the live registry and walk the same forest, so
// the two views never drift.

import { getPackage } from '../core/parts/partRegistry'
import type { PartPackageGeometry, RigJoint, RigLink, RigShape } from '../core/parts/partPackage'
import type { SdkPart, PartInstance } from '../core/types'
import { convertUnit, displayUnitFor, METRIC_DISPLAY, type DisplayUnits } from '../core/units'

/** The rig variant of a part package's geometry (links + joints). */
export type RigGeometry = Extract<PartPackageGeometry, { kind: 'rig' }>

/** The rig geometry of a custom rig part, or null for any other part (built-in, deck custom, unloaded). */
export function rigGeometryOf(part: PartInstance): RigGeometry | null {
  if (part.type !== 'part') return null
  const pkg = getPackage((part as SdkPart).packageId)
  return pkg && pkg.geometry.kind === 'rig' ? pkg.geometry : null
}

/** One-line label for a rig link's shape (the geometry kind, plus the GLB node for a mesh link). */
export function shapeLabel(shape: RigShape): string {
  switch (shape.kind) {
    case 'box':
      return 'box'
    case 'cylinder':
      return 'cylinder'
    case 'cone':
      return 'cone'
    case 'frame':
      return 'frame'
    case 'mesh':
      return shape.node ? `mesh · ${shape.node}` : 'mesh'
    case 'label':
      return 'label'
    case 'leg':
      return 'leg'
  }
}

/** Human-readable command range for a joint: degrees for revolute; for prismatic, metres or inches by `system`. */
export function jointRange(j: RigJoint, system: DisplayUnits = METRIC_DISPLAY): string {
  if (j.type === 'revolute') {
    const lo = ((j.min * 180) / Math.PI).toFixed(0)
    const hi = ((j.max * 180) / Math.PI).toFixed(0)
    return `${lo}° … ${hi}°`
  }
  const u = displayUnitFor('m', system)
  return `${convertUnit(j.min, 'm', u).toFixed(2)} … ${convertUnit(j.max, 'm', u).toFixed(2)} ${u}`
}

export interface RigForest {
  /** links with no parent (or a dangling parent) - the roots of the kinematic tree */
  roots: RigLink[]
  /** parent link name -> its child links, in declaration order */
  childrenOf: Map<string, RigLink[]>
  /** link name -> the joint that drives it (a link has at most one driving joint) */
  jointByLink: Map<string, RigJoint>
}

/** Build the parent→children forest + link→joint index for a rig, for recursive rendering. */
export function rigForest(geometry: RigGeometry): RigForest {
  const { links, joints } = geometry
  const names = new Set(links.map((l) => l.name))
  const childrenOf = new Map<string, RigLink[]>()
  const roots: RigLink[] = []
  for (const l of links) {
    if (l.parent !== undefined && names.has(l.parent)) {
      const arr = childrenOf.get(l.parent) ?? []
      arr.push(l)
      childrenOf.set(l.parent, arr)
    } else {
      roots.push(l)
    }
  }
  return { roots, childrenOf, jointByLink: new Map(joints.map((j) => [j.link, j])) }
}

/** A link and every link under it: what deleting it removes. */
export function rigSubtree(geometry: RigGeometry, linkName: string): Set<string> {
  const out = new Set<string>([linkName])
  for (let grew = true; grew; ) {
    grew = false
    for (const l of geometry.links) {
      if (l.parent && out.has(l.parent) && !out.has(l.name)) {
        out.add(l.name)
        grew = true
      }
    }
  }
  return out
}

/**
 * Whether a node may be deleted: not when its subtree is the whole rig, since a part needs at least one node.
 * Counting links alone would say yes to a root holding everything, and the click would then do nothing. The controller
 * refuses by this, and every Delete (the Scene dock's, the Inspector's) is enabled by it.
 */
export function canDeleteRigNode(geometry: RigGeometry, linkName: string): boolean {
  return rigSubtree(geometry, linkName).size < geometry.links.length
}

/** One rig link as a flat ordered row: its link + driving joint + display depth. */
export interface RigRow {
  link: RigLink
  joint: RigJoint | undefined
  depth: number
}

/** Pre-order flatten of a rig forest into the ordered rows the tree renders - the rig analogue of the scene's
 *  `orderedTree`, so rig links can render through the same flat row loop + component as scene parts,
 *  not a recursive one. `baseDepth` is the depth of the owning part's row (links nest one level under it). */
export function flattenRigForest(geometry: RigGeometry, baseDepth: number): RigRow[] {
  const { roots, childrenOf, jointByLink } = rigForest(geometry)
  const out: RigRow[] = []
  const walk = (link: RigLink, depth: number): void => {
    out.push({ link, joint: jointByLink.get(link.name), depth })
    for (const k of childrenOf.get(link.name) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, baseDepth + 1)
  return out
}

// ---- authoring: the shape kinds the Inspector can construct ----------------

/**
 * The shape kinds an author can pick in the Inspector's shape selector. The rest of the `RigShape` union is
 * appliance geometry (`roller`/`chain`/`leg` carry a bank layout or GLB node bindings, `deck`/`label` carry
 * their own fields), so the panel displays those kinds (the selector must always show what a link really is) but
 * never constructs one. `mesh` is reached through Import model, the only route that can supply the GLB it
 * needs. Converting away from any of them is fine, since the replacement is a self-contained primitive.
 */
export const AUTHORABLE_SHAPE_KINDS = ['box', 'cylinder', 'cone', 'frame'] as const

/** A shape kind the Inspector can build from nothing - the picker's options, and `addRigNode`'s argument. */
export type AuthorableShapeKind = (typeof AUTHORABLE_SHAPE_KINDS)[number]

/** Narrow a raw `<select>` value to a kind the picker can convert to. */
export function isAuthorableShapeKind(kind: string): kind is AuthorableShapeKind {
  return (AUTHORABLE_SHAPE_KINDS as readonly string[]).includes(kind)
}

/** the size a node with nothing to inherit is born at: a 0.3 m cube, or the round shape that fills it */
const NEW_NODE_EXTENT = 0.3

/** Dimensions of a fresh node of `kind` (what ＋ Add child node drops in). */
export function defaultShape(kind: AuthorableShapeKind): RigShape {
  return buildShape(kind, NEW_NODE_EXTENT / 2, NEW_NODE_EXTENT)
}

/**
 * Re-shape a link to another authorable kind, carrying its dimensions across: a 2 m tall cylinder switched to
 * a box stays 2 m tall instead of snapping back to a default cube and making the author re-type the size they
 * just dialled in. Radius maps to half the wider horizontal extent, so box → cylinder → box round-trips a
 * square footprint and squares off a rectangular one (a cylinder has no separate X and Z to preserve).
 *
 * `sizeParams` is dropped rather than carried: a box's entry indexes the axis it stretches, while
 * a cylinder's axis 1 is the height and axes 0 and 2 both mean the radius, so copying the array across a
 * shape change would silently stretch the wrong dimension, or double-apply on a round one. No panel field
 * authors sizeParams today (a rig that uses them declares them in the part script), and losing them visibly
 * is better than a link that quietly grows on the wrong axis.
 */
export function convertShape(shape: RigShape, kind: AuthorableShapeKind, meshBox?: readonly [number, number, number]): RigShape {
  const { radius, height } = shapeExtents(shape, meshBox)
  return buildShape(kind, radius, height)
}

/** the radius/height a shape hands to its replacement; a shape with no dimensions of its own uses the default */
function shapeExtents(shape: RigShape, meshBox?: readonly [number, number, number]): { radius: number; height: number } {
  switch (shape.kind) {
    case 'box':
      return { radius: Math.max(shape.size[0], shape.size[2]) / 2, height: shape.size[1] }
    case 'cylinder':
    case 'cone':
      return { radius: shape.radius, height: shape.height }
    case 'mesh':
      // a visual mesh's own extent lives in the GLB, which the panel can't measure; its collision box is the
      // one real dimension the package itself declares, so inherit that when there is one
      return meshBox
        ? { radius: Math.max(meshBox[0], meshBox[2]) / 2, height: meshBox[1] }
        : { radius: NEW_NODE_EXTENT / 2, height: NEW_NODE_EXTENT }
    default:
      // frame (no geometry at all), label (a text plane), and the appliance kinds carry nothing a primitive
      // can meaningfully inherit - start the replacement at the default size
      return { radius: NEW_NODE_EXTENT / 2, height: NEW_NODE_EXTENT }
  }
}

/** the one place a primitive's dimensions become a shape, so defaultShape and convertShape can't disagree */
function buildShape(kind: AuthorableShapeKind, radius: number, height: number): RigShape {
  switch (kind) {
    case 'box':
      return { kind: 'box', size: [radius * 2, height, radius * 2] }
    case 'cylinder':
      return { kind: 'cylinder', radius, height }
    case 'cone':
      return { kind: 'cone', radius, height }
    case 'frame':
      return { kind: 'frame' }
  }
}
