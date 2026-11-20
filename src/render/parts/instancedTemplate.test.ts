import { describe, it, expect } from 'vitest'
import { InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { sweepProfileAlongX } from '../../core/geometry/meshDescription'
import type { InstanceTransform } from '../../core/parts/partApi'
import { bucketCapacity } from './instanceCapacity'
import { realizeInstancedTemplate, writeInstanceMatrices, writeInstanceMatricesHeld } from './instancedTemplate'
import { geometryContentKey } from './geometryKey'
import { legPieces, type LegPiece } from './common'

// A fresh unit-box MeshDescription per call (a square profile swept 1m along X). Fresh so each bank
// realizes its own geometry object - the state two different parts are actually in.
const unitBox = () =>
  sweepProfileAlongX([[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]], [-0.5, 0.5])

const t = (position: [number, number, number], scale?: [number, number, number], quaternion?: [number, number, number, number]): InstanceTransform =>
  ({ position, ...(scale ? { scale } : {}), ...(quaternion ? { quaternion } : {}) })

describe('instancedTemplate - realizeInstancedTemplate', () => {
  it('draws N transforms of one template as a single InstancedMesh', () => {
    const mesh = realizeInstancedTemplate(unitBox(), [t([0, 0, 0]), t([1, 0, 0]), t([2, 0, 0])], new MeshStandardMaterial())
    expect(mesh).toBeInstanceOf(InstancedMesh)
    expect(mesh.count).toBe(3)
  })

  it('composes position, scale and rotation per instance', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3)
    const mesh = realizeInstancedTemplate(unitBox(), [t([1, 2, 3], [4, 5, 6], [q.x, q.y, q.z, q.w])], new MeshStandardMaterial())
    const pos = new Vector3(), quat = new Quaternion(), scale = new Vector3()
    new Matrix4().copy(readMatrix(mesh, 0)).decompose(pos, quat, scale)
    expect([pos.x, pos.y, pos.z]).toEqual([1, 2, 3])
    expect(scale.x).toBeCloseTo(4, 6)
    expect(scale.y).toBeCloseTo(5, 6)
    expect(scale.z).toBeCloseTo(6, 6)
    expect(quat.angleTo(q)).toBeCloseTo(0, 6)
  })

  it('defaults scale to unit and rotation to identity when omitted', () => {
    const mesh = realizeInstancedTemplate(unitBox(), [t([0, 0, 0])], new MeshStandardMaterial())
    const pos = new Vector3(), quat = new Quaternion(), scale = new Vector3()
    readMatrix(mesh, 0).decompose(pos, quat, scale)
    expect(scale.x).toBeCloseTo(1, 6)
    expect(scale.y).toBeCloseTo(1, 6)
    expect(scale.z).toBeCloseTo(1, 6)
    expect(quat.angleTo(new Quaternion())).toBeCloseTo(0, 6)
  })

  it('an empty bank has count 0 and a finite, cull-safe bounding sphere', () => {
    const mesh = realizeInstancedTemplate(unitBox(), [], new MeshStandardMaterial())
    expect(mesh.count).toBe(0)
    expect(mesh.boundingSphere).not.toBeNull()
    expect(Number.isFinite(mesh.boundingSphere!.radius)).toBe(true)
  })

  it('is poolable by construction (default layer, no instanceColor / dynamicInstances / spin)', () => {
    const mesh = realizeInstancedTemplate(unitBox(), [t([0, 0, 0]), t([1, 0, 0])], new MeshStandardMaterial())
    expect(mesh.layers.mask).toBe(1) // default layer → the pool considers it
    expect(mesh.instanceColor).toBeNull() // per-instance colour would exclude it
    expect(mesh.userData.dynamicInstances).toBeUndefined() // not a per-frame batch
    expect((mesh.material as MeshStandardMaterial).userData.spinUniform).toBeUndefined()
  })

  it('writeInstanceMatrices shrinks the live count without reallocating', () => {
    const mesh = realizeInstancedTemplate(unitBox(), [t([0, 0, 0]), t([1, 0, 0]), t([2, 0, 0])], new MeshStandardMaterial())
    const cap = mesh.instanceMatrix.count
    writeInstanceMatrices(mesh, [t([5, 0, 0])])
    expect(mesh.count).toBe(1)
    expect(mesh.instanceMatrix.count).toBe(cap) // buffer reused
  })

  it('reserves buffer headroom above the live count so a small resize stays under capacity', () => {
    // 5 rollers → the count outgrowing the buffer is what forces a fresh mesh (WebGPU cold-compile hitch).
    // A bucketed buffer leaves room to grow without reallocating: the draw count is exact (5) but the
    // buffer capacity is the bucket, so extending the conveyor a little reuses this same mesh.
    const mesh = realizeInstancedTemplate(unitBox(), Array.from({ length: 5 }, (_, i) => t([i, 0, 0])), new MeshStandardMaterial())
    expect(mesh.count).toBe(5) // exact draw count
    expect(mesh.instanceMatrix.count).toBe(bucketCapacity(5)) // bucketed capacity → headroom for a resize
    // growing 5 → 8 stays in-bounds and reuses the buffer (no realloc = no mint = no cold pipeline)
    const cap = mesh.instanceMatrix.count
    writeInstanceMatrices(mesh, Array.from({ length: 8 }, (_, i) => t([i, 0, 0])))
    expect(mesh.count).toBe(8)
    expect(mesh.instanceMatrix.count).toBe(cap)
  })
})

// The built-in trestle leg (legPieces) must round-trip through MeshPart.instances: if the leg can't be
// expressed this way, the author API is the wrong shape.
const UP = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2) // built-in bolt up-tilt (legQuatUp)
const toInstances = (pieces: LegPiece[]): InstanceTransform[] =>
  pieces.map((p) => t([p.px, p.py, p.pz], [p.sx, p.sy, p.sz], p.up ? [UP.x, UP.y, UP.z, UP.w] : undefined))

describe('leg round-trips through the instanced-template API (acid test)', () => {
  it('expresses a real trestle leg as box + bolt banks matching legPieces exactly', () => {
    const { boxes, bolts } = legPieces(1.0, 1.2)
    expect(boxes.length).toBeGreaterThan(0)
    expect(bolts.length).toBeGreaterThan(0)

    const boxMesh = realizeInstancedTemplate(unitBox(), toInstances(boxes), new MeshStandardMaterial())
    const boltMesh = realizeInstancedTemplate(unitBox(), toInstances(bolts), new MeshStandardMaterial())
    expect(boxMesh.count).toBe(boxes.length) // one draw call for every box piece of the leg
    expect(boltMesh.count).toBe(bolts.length)

    // box[0]'s baked matrix decomposes back to its LegPiece position + scale (size lives in the scale,
    // template stays a unit box - the unitBox discipline that keeps it poolable across sizes)
    const pos = new Vector3(), quat = new Quaternion(), scale = new Vector3()
    readMatrix(boxMesh, 0).decompose(pos, quat, scale)
    expect(pos.x).toBeCloseTo(boxes[0]!.px, 6)
    expect(pos.y).toBeCloseTo(boxes[0]!.py, 6)
    expect(pos.z).toBeCloseTo(boxes[0]!.pz, 6)
    expect(scale.x).toBeCloseTo(boxes[0]!.sx, 6)
    expect(scale.y).toBeCloseTo(boxes[0]!.sy, 6)
    expect(scale.z).toBeCloseTo(boxes[0]!.sz, 6)

    // a standing foot bolt carries the -90° X-axis tilt
    const upIdx = bolts.findIndex((b) => b.up)
    expect(upIdx).toBeGreaterThanOrEqual(0)
    readMatrix(boltMesh, upIdx).decompose(pos, quat, scale)
    expect(quat.angleTo(UP)).toBeCloseTo(0, 6)
  })

  it('pools across parts: two parts emitting the same leg share one geometry content key', () => {
    const a = realizeInstancedTemplate(unitBox(), toInstances(legPieces(1.0, 1.2).boxes), new MeshStandardMaterial())
    const b = realizeInstancedTemplate(unitBox(), toInstances(legPieces(1.0, 1.2).boxes), new MeshStandardMaterial())
    expect(a.geometry).not.toBe(b.geometry) // each part realizes its OWN template geometry object
    expect(geometryContentKey(a.geometry)).toBe(geometryContentKey(b.geometry)) // → merge in the instance pool
  })
})

function readMatrix(mesh: InstancedMesh, i: number): Matrix4 {
  const m = new Matrix4()
  mesh.getMatrixAt(i, m)
  return m
}

// A roller bed sliding along its world grid holds n rollers at one phase and n+1 at the next. A render bundle bakes the
// instance count, so the held writer keeps the drawn count at its high-water mark and parks the surplus as collapsed
// copies: sliding back and forth costs one re-record, not one per pointer-move.
describe('writeInstanceMatricesHeld - a count that comes and goes', () => {
  const row = (n: number, x0 = 0): InstanceTransform[] => Array.from({ length: n }, (_, i) => t([x0 + i * 0.075, 0, 0], [0.2, 0.2, 0.8]))
  it('holds the drawn count when the bank shrinks, parking the surplus at zero scale on the first instance', () => {
    const mesh = realizeInstancedTemplate(unitBox(), row(27), new MeshStandardMaterial())
    expect(writeInstanceMatricesHeld(mesh, row(26, 0.01))).toBe(false) // not structural
    expect(mesh.count).toBe(27)
    const parked = readMatrix(mesh, 26).elements
    expect([0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => parked[i])).toEqual(Array(9).fill(0)) // zero scale: draws nothing
    expect(parked[12]).toBeCloseTo(0.01, 6) // parked on the first instance, inside the bounds
    const pos = new Vector3(), quat = new Quaternion(), scale = new Vector3()
    new Matrix4().copy(readMatrix(mesh, 25)).decompose(pos, quat, scale)
    expect(pos.x).toBeCloseTo(0.01 + 25 * 0.075, 6) // the real ones are all written
    expect(writeInstanceMatricesHeld(mesh, row(27))).toBe(false) // back up to the mark: still no change
    expect(mesh.count).toBe(27)
  })

  it('reports a growth past the mark, and an emptied bank, as a drawn-count change', () => {
    const mesh = realizeInstancedTemplate(unitBox(), row(10), new MeshStandardMaterial())
    expect(writeInstanceMatricesHeld(mesh, row(11))).toBe(true)
    expect(mesh.count).toBe(11)
    expect(writeInstanceMatricesHeld(mesh, [])).toBe(true)
    expect(mesh.count).toBe(0)
  })
})
