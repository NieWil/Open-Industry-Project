import { describe, expect, it } from 'vitest'
import { BufferGeometry, Float32BufferAttribute, Mesh, Raycaster, Vector3 } from 'three'
import { sweepProfileAlongX } from '../../core/geometry/meshDescription'
import { realizeMeshDescription, rewriteMeshDescription } from './meshDescriptionGeometry'
import { ensureColliderBVH, markLazyColliderBVH } from '../bvh'
import { evalPartGeometry, resolvePartParams } from '../../core/geometry/geometryEval'
import { instantiatePartScript } from '../../core/parts/partScript'
import { examplePart } from './examplePart'

// The host realization step: a portable MeshDescription → a three.js BufferGeometry. BufferGeometry +
// computeVertexNormals are pure math (no GL), so this runs in the node test env.

// the SDK belt deck cross-section (top face at y=0), as in meshDescription.test.ts
const deckSection: Array<[number, number]> = [
  [-0.1, -0.5],
  [-0.1, 0.5],
  [0, 0.5],
  [0, -0.5],
]

describe('meshDescriptionGeometry - realizeMeshDescription', () => {
  it('maps the description buffers onto BufferGeometry attributes + index', () => {
    const desc = sweepProfileAlongX(deckSection, [0, 3]) // 16 verts (a hard edge at each corner), 24 indices
    const geo = realizeMeshDescription(desc)

    expect(geo.getAttribute('position').count).toBe(16)
    expect(geo.getAttribute('position').itemSize).toBe(3)
    expect(geo.getAttribute('uv').count).toBe(16)
    expect(geo.getAttribute('uv').itemSize).toBe(2)
    expect(geo.getIndex()!.count).toBe(24)
    // the description carries no normals; the host derives them
    expect(geo.getAttribute('normal').count).toBe(16)
  })

  it('derives unit-length vertex normals from the faces', () => {
    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, [0, 1, 2, 3]))
    const n = geo.getAttribute('normal')
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i))
      expect(len).toBeCloseTo(1, 5)
    }
  })

  it('round-trips the exact vertex positions', () => {
    const desc = sweepProfileAlongX(deckSection, [0, 3])
    const pos = realizeMeshDescription(desc).getAttribute('position')
    expect(pos.getX(0)).toBeCloseTo(desc.positions[0]!, 6)
    expect(pos.getY(0)).toBeCloseTo(desc.positions[1]!, 6)
    expect(pos.getZ(0)).toBeCloseTo(desc.positions[2]!, 6)
  })
})

// Recycling means a re-emit frees nothing: same buffers, new numbers. So these check not just that the
// values were written but that the array identity survived. A rewrite that swapped in a new array would
// destroy the old GPUBuffer under any recording holding it, the failure gpuRetire.ts guards against (a
// black viewport, no throw).
describe('meshDescriptionGeometry - rewriteMeshDescription', () => {
  it('rewrites in place, keeping every buffer identity', () => {
    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, [0, 3]))
    const pos = geo.getAttribute('position')
    const uv = geo.getAttribute('uv')
    const normal = geo.getAttribute('normal')
    const index = geo.getIndex()!
    const arrays = [pos.array, uv.array, normal.array, index.array]

    // same topology, new coordinates - the per-pointer-move case
    const moved = sweepProfileAlongX(deckSection, [0, 5])
    expect(rewriteMeshDescription(geo, moved)).toBe(true)

    expect(geo.getAttribute('position').array).toBe(arrays[0])
    expect(geo.getAttribute('uv').array).toBe(arrays[1])
    expect(geo.getAttribute('normal').array).toBe(arrays[2])
    expect(geo.getIndex()!.array).toBe(arrays[3])
    expect(pos.getX(0)).toBeCloseTo(moved.positions[0]!, 6)
    // ...and the new geometry is genuinely there, not just the old numbers (float32 round-trip, so
    // compare against the description narrowed to float32 rather than its float64 source values)
    expect(Array.from(pos.array as Float32Array)).toEqual(Array.from(Float32Array.from(moved.positions)))
  })

  it('re-derives normals and drops stale bounds', () => {
    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, [0, 3]))
    geo.computeBoundingSphere()
    expect(geo.boundingSphere).not.toBeNull()

    expect(rewriteMeshDescription(geo, sweepProfileAlongX(deckSection, [0, 9]))).toBe(true)
    expect(geo.boundingSphere!.center.x).toBeCloseTo(4.5, 6) // derived from the new vertices, not the 3 m deck's
    expect(geo.boundingBox!.max.x).toBeCloseTo(9, 6)
    const n = geo.getAttribute('normal')
    for (let i = 0; i < n.count; i++) {
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5)
    }
  })

  it('refuses a different vertex or index count, leaving the geometry untouched', () => {
    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, [0, 3]))
    const before = Array.from(geo.getAttribute('position').array as Float32Array)

    // a real topology change (an extra sweep station) - caller must mint + retire instead
    expect(rewriteMeshDescription(geo, sweepProfileAlongX(deckSection, [0, 1, 3]))).toBe(false)
    expect(Array.from(geo.getAttribute('position').array as Float32Array)).toEqual(before)
  })

  it('refuses a geometry that is not shaped like a realized description', () => {
    const bare = new BufferGeometry()
    bare.setAttribute('position', new Float32BufferAttribute(new Float32Array(24), 3))
    // no uv, no normal, no index
    expect(rewriteMeshDescription(bare, sweepProfileAlongX(deckSection, [0, 3]))).toBe(false)
  })

  it('refuses indices a Uint16 buffer cannot hold', () => {
    // an equal vertex count does not prove the new indices fit: three sized the index type from the
    // previous max index, so a re-emit that reaches higher would silently wrap without this check
    const geo = new BufferGeometry()
    const verts = 8
    geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setAttribute('uv', new Float32BufferAttribute(new Float32Array(verts * 2), 2))
    geo.setAttribute('normal', new Float32BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setIndex([0, 1, 2]) // max index 2 ⇒ Uint16
    expect(geo.getIndex()!.array.BYTES_PER_ELEMENT).toBe(2)

    const overflow = { positions: new Array<number>(verts * 3).fill(0), uvs: new Array<number>(verts * 2).fill(0), indices: [0, 1, 70000] }
    expect(rewriteMeshDescription(geo, overflow)).toBe(false)
  })
})

describe('meshDescriptionGeometry - lazy collider BVH (bvh.ts)', () => {
  // enough stations to clear MIN_TRIS_FOR_BVH (256)
  const stations = Array.from({ length: 60 }, (_, i) => i * 0.1)
  const downRay = (x: number, z: number) => {
    const rc = new Raycaster(new Vector3(x, 5, z), new Vector3(0, -1, 0))
    return rc
  }

  it('builds only for a marked mesh, and leaves the index buffer untouched', () => {
    const plain = new Mesh(realizeMeshDescription(sweepProfileAlongX(deckSection, stations)))
    ensureColliderBVH(plain)
    expect((plain.geometry as { boundsTree?: unknown }).boundsTree).toBeFalsy()

    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, stations))
    const indexBefore = Array.from(geo.index!.array)
    const mesh = new Mesh(geo)
    markLazyColliderBVH(mesh)
    ensureColliderBVH(mesh)
    expect((geo as { boundsTree?: unknown }).boundsTree).toBeTruthy()
    // a default build reorders the index in place; the instance pool hashes it and rewrites overwrite it
    expect(Array.from(geo.index!.array)).toEqual(indexBefore)
    // same hit as the stock brute-force raycast on the untreed twin
    const hit = downRay(2.05, 0).intersectObject(mesh, false)[0]
    expect(hit).toBeDefined()
    expect(hit!.point.y).toBeCloseTo(downRay(2.05, 0).intersectObject(plain, false)[0]!.point.y, 5)
  })

  it('drops the tree on an in-place rewrite, so a ray sees the new shape', () => {
    const geo = realizeMeshDescription(sweepProfileAlongX(deckSection, stations))
    const mesh = new Mesh(geo)
    markLazyColliderBVH(mesh)
    ensureColliderBVH(mesh)
    // same topology, slid 10 m along X - the recycle path a resize drag takes
    expect(rewriteMeshDescription(geo, sweepProfileAlongX(deckSection, stations.map((x) => x + 10)))).toBe(true)
    expect((geo as { boundsTree?: unknown }).boundsTree).toBeFalsy()
    expect(downRay(2.05, 0).intersectObject(mesh, false)).toHaveLength(0)
    ensureColliderBVH(mesh)
    expect((geo as { boundsTree?: unknown }).boundsTree).toBeTruthy()
    const moved = new Mesh(realizeMeshDescription(sweepProfileAlongX(deckSection, stations.map((x) => x + 10))))
    const hit = downRay(12.05, 0).intersectObject(mesh, false)[0]
    expect(hit).toBeDefined()
    expect(hit!.point.y).toBeCloseTo(downRay(12.05, 0).intersectObject(moved, false)[0]!.point.y, 5)
    expect(downRay(2.05, 0).intersectObject(mesh, false)).toHaveLength(0)
  })
})

describe('meshDescriptionGeometry - normals and bounds match three', () => {
  // realize/rewrite derive normals and bounds in their own loop for speed; three's functions are the reference
  const threeReference = (geo: BufferGeometry): BufferGeometry => {
    const ref = new BufferGeometry()
    ref.setAttribute('position', geo.getAttribute('position').clone())
    ref.setIndex(geo.index!.clone())
    ref.computeVertexNormals()
    ref.computeBoundingBox()
    ref.computeBoundingSphere()
    return ref
  }
  const expectSame = (geo: BufferGeometry): void => {
    const ref = threeReference(geo)
    expect(Array.from(geo.getAttribute('normal').array)).toEqual(Array.from(ref.getAttribute('normal').array))
    expect(geo.boundingBox!.min.toArray()).toEqual(ref.boundingBox!.min.toArray())
    expect(geo.boundingBox!.max.toArray()).toEqual(ref.boundingBox!.max.toArray())
    expect(geo.boundingSphere!.center.toArray()).toEqual(ref.boundingSphere!.center.toArray())
    expect(geo.boundingSphere!.radius).toBe(ref.boundingSphere!.radius)
  }

  for (const id of ['oip.platform', 'oip.rack']) {
    it(`${id}: bit-identical on realize and on an in-place rewrite`, () => {
      const { behavior } = examplePart(id)
      const specs = instantiatePartScript(behavior).def?.params ?? {}
      const base = resolvePartParams(specs, {})
      const at = (length: number) => evalPartGeometry(behavior, { ...base, length })!.filter((m) => !m.instances)
      const first = at(base.length as number)
      const next = at((base.length as number) + 0.013)
      expect(first.length).toBeGreaterThan(0)
      for (let i = 0; i < first.length; i++) {
        const geo = realizeMeshDescription(first[i]!.desc)
        expectSame(geo)
        if (rewriteMeshDescription(geo, next[i]!.desc)) expectSame(geo)
      }
    })
  }
})
