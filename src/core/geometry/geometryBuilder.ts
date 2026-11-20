// The GeometryBuilder implementation - the `g` handed to a part's `definePart({ geometry })` callback
// (docs/procedural-geometry.md, Tier 2). It is a curated set of mid-level constructive ops. A part composes
// domain-general primitives (sweep a profile, fillet a polyline, sample an arc, a box, merge pieces) and returns a
// portable MeshDescription. The alternatives were (a) pushing raw vertices by hand, which invites inconsistent
// geometry, or (b) hard-coding domain shapes (a belt path, a pulley loop) in the builder, which the host would have
// to extend per part. Nothing belt-specific is here. A belt's bent centreline is `fillet(corners, height)` over
// corners the part computes from its segments, and the end-drum wraps are `arc(...)` calls in the belt's
// geometry(). Part geometry is limited to vetted primitives under a vertex budget, as behavior code is limited too.
//
// Pure + deterministic (no Date/Math.random/host handles), so the same builder runs identically on both
// shipping surfaces and the description is reproducible. Every op that allocates is vertex-budget-capped via
// meshDescription's GeometryBudgetError, the geometry analogue of the determinism guard + spawn caps.

import type { GeometryBuilder, MeshDescription, SurfaceBuilder } from '../parts/partApi'
import { GeometryBudgetError, MAX_DESCRIPTION_VERTICES, loftSections, sweepProfileAlongPath } from './meshDescription'
import type { Vec3 } from './meshDescription'
import { bevelBoxDescription, cylinderDescription, extrudeDescription, latheDescription, transformDescription } from './geometryShapes'
import { subtractDescriptions } from './geometryCsg'
import { filletCorner } from '../filletCorner'

/** default arc sub-segments per filleted corner / per arc() call */
const DEFAULT_ARC_SEG = 6

/** Concatenate descriptions into one mesh, re-basing each part's indices onto the running vertex offset.
 *  Budget-checked against the combined vertex count (a merge can blow the cap even when each piece is fine). */
function mergeDescriptions(parts: readonly MeshDescription[]): MeshDescription {
  const positions: number[] = []
  const indices: number[] = []
  const uvs: number[] = []
  let vertexOffset = 0
  for (const part of parts) {
    const vCount = (part.positions.length / 3) | 0
    if (vertexOffset + vCount > MAX_DESCRIPTION_VERTICES) throw new GeometryBudgetError(vertexOffset + vCount)
    for (let i = 0; i < part.positions.length; i++) positions.push(part.positions[i]!)
    for (let i = 0; i < part.uvs.length; i++) uvs.push(part.uvs[i]!)
    for (let i = 0; i < part.indices.length; i++) indices.push(part.indices[i]! + vertexOffset)
    vertexOffset += vCount
  }
  return { positions, indices, uvs }
}

/** An axis-aligned box (full `size`, centred at `center`) as a 24-vertex description - 4 verts per face so each
 *  face shades flat (a leg/foot shows hard edges instead of smooth shading). CCW-outward winding → outward normals. */
function boxDescription(size: readonly [number, number, number], center: readonly [number, number, number]): MeshDescription {
  const hx = size[0] / 2
  const hy = size[1] / 2
  const hz = size[2] / 2
  const x0 = center[0] - hx
  const x1 = center[0] + hx
  const y0 = center[1] - hy
  const y1 = center[1] + hy
  const z0 = center[2] - hz
  const z1 = center[2] + hz
  const positions: number[] = []
  const indices: number[] = []
  const uvs: number[] = []
  const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    const base = positions.length / 3
    for (const p of [a, b, c, d]) positions.push(p[0], p[1], p[2])
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]) // +X
  face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]) // -X
  face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]) // +Y (top)
  face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]) // -Y (bottom)
  face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]) // +Z
  face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]) // -Z
  return { positions, indices, uvs }
}

/** Round the interior corners of an open polyline with tangent arcs of `radius`, in the X-Y plane (Z carried
 *  through). The general fillet primitive a part composes a bent path from (a belt centreline, a rounded
 *  bracket). The inset at each corner is clamped to half the shorter adjacent segment so tight corners /
 *  small radii stay well-formed. Endpoints are kept. */
function filletPolyline(points: ReadonlyArray<Vec3>, radius: number, arcSegments: number): Vec3[] {
  const n = points.length
  if (n < 3 || radius <= 0) return points.map((p) => [p[0], p[1], p[2]] as Vec3)
  const seg = Math.max(1, Math.floor(arcSegments))
  const out: Vec3[] = [[points[0]![0], points[0]![1], points[0]![2]]]
  for (let i = 1; i < n - 1; i++) {
    const A = points[i - 1]!
    const P = points[i]!
    const B = points[i + 1]!
    let inx = P[0] - A[0]
    let iny = P[1] - A[1]
    let outx = B[0] - P[0]
    let outy = B[1] - P[1]
    const inLen = Math.hypot(inx, iny)
    const outLen = Math.hypot(outx, outy)
    if (inLen < 1e-9 || outLen < 1e-9) {
      out.push([P[0], P[1], P[2]])
      continue
    }
    inx /= inLen
    iny /= inLen
    outx /= outLen
    outy /= outLen
    const turn = Math.atan2(inx * outy - iny * outx, inx * outx + iny * outy) // signed deflection
    const half = Math.abs(turn) / 2
    if (half < 1e-6) {
      out.push([P[0], P[1], P[2]])
      continue
    }
    const { inset, radius: rArc } = filletCorner(radius, Math.abs(turn), inLen, outLen) // rArc ≤ radius
    const sign = Math.sign(turn)
    const t1x = P[0] - inx * inset
    const t1y = P[1] - iny * inset
    const cx = t1x - iny * sign * rArc // arc centre: perpendicular to the incoming dir, toward the turn side
    const cy = t1y + inx * sign * rArc
    const v0x = t1x - cx
    const v0y = t1y - cy
    for (let k = 0; k <= seg; k++) {
      const a = (turn * k) / seg
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      out.push([cx + v0x * ca - v0y * sa, cy + v0x * sa + v0y * ca, P[2]])
    }
  }
  out.push([points[n - 1]![0], points[n - 1]![1], points[n - 1]![2]])
  return out
}

/** Build a fresh GeometryBuilder. Stateless - a new one per geometry() call keeps the op surface pure. */
export function createGeometryBuilder(): GeometryBuilder {
  return {
    sweep(profile, path, opts): MeshDescription {
      // sweepProfileAlongPath already validates the profile/station counts and enforces the vertex budget.
      return sweepProfileAlongPath(profile, path as readonly Vec3[], opts)
    },
    loft(sections, path, opts): MeshDescription {
      return loftSections(sections, path as readonly Vec3[], opts)
    },
    box(size, center): MeshDescription {
      return boxDescription(size, center)
    },
    surface(): SurfaceBuilder {
      // a fresh accumulator per call; the part pushes verts/tris then build()s. Budget-capped on each vertex
      // so a runaway loop can't allocate without bound (the low-level analogue of the sweep budget check).
      const positions: number[] = []
      const uvs: number[] = []
      const indices: number[] = []
      return {
        vertex(x, y, z, u = 0, v = 0): number {
          const idx = positions.length / 3
          if (idx >= MAX_DESCRIPTION_VERTICES) throw new GeometryBudgetError(idx + 1)
          positions.push(x, y, z)
          uvs.push(u, v)
          return idx
        },
        triangle(a, b, c): void {
          indices.push(a, b, c)
        },
        quad(a, b, c, d): void {
          indices.push(a, b, c, a, c, d)
        },
        build(): MeshDescription {
          return { positions, indices, uvs }
        },
      }
    },
    fillet(points, radius, arcSegments = DEFAULT_ARC_SEG): ReadonlyArray<readonly [number, number, number]> {
      return filletPolyline(points as readonly Vec3[], radius, arcSegments)
    },
    arc(center, radius, start, end, segments = 8): ReadonlyArray<readonly [number, number, number]> {
      const seg = Math.max(1, Math.floor(segments))
      const out: Vec3[] = []
      for (let i = 0; i <= seg; i++) {
        const a = start + (end - start) * (i / seg)
        out.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), center[2]])
      }
      return out
    },
    merge(...parts: readonly MeshDescription[]): MeshDescription {
      return mergeDescriptions(parts)
    },
    // the solid-shape ops (geometryShapes.ts): engineered hardware as the numbers a drawing gives
    bevelBox(size, center, bevel, square): MeshDescription {
      return bevelBoxDescription(size, center, bevel, square)
    },
    lathe(profile, opts): MeshDescription {
      return latheDescription(profile, opts)
    },
    extrude(outline, from, to, opts): MeshDescription {
      return extrudeDescription(outline, from, to, opts)
    },
    transform(desc, opts): MeshDescription {
      return transformDescription(desc, opts)
    },
    cylinder(radius, height, center, opts): MeshDescription {
      return cylinderDescription(radius, height, center, opts)
    },
    subtract(solid, ...cutters): MeshDescription {
      return subtractDescriptions(solid, cutters)
    },
  }
}
