// The geometry a cargo part's batch is merged from (bakedCargoGeometry): a model's attributes arrive in whatever form
// its file stores them, and the bake has to give floats in part-local metres for all of them.
import { describe, expect, it } from 'vitest'
import { BoxGeometry, BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Matrix4 } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { bakedCargoGeometry } from './partCargoMesh'

const positions = (g: BufferGeometry): number[] => Array.from(g.getAttribute('position').array as Float32Array, (v) => +v.toFixed(4))

/** one triangle with corners at -1, 0 and 1 along X, stored as a quantized model stores it: normalized int16 */
function quantizedTriangle(): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Int16Array([-32767, 0, 0, 0, 32767, 0, 32767, 0, 0]), 3, true))
  g.setAttribute('normal', new BufferAttribute(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), 3, true))
  g.setAttribute('uv', new BufferAttribute(new Uint16Array([0, 0, 32768, 65535, 65535, 0]), 2, true))
  return g
}

describe('bakedCargoGeometry', () => {
  it('bakes normalized integer positions to metres, past the ±1 an integer attribute can hold', () => {
    // the model's size is on its node: 2.5 m either side of the origin
    const out = bakedCargoGeometry(quantizedTriangle(), new Matrix4().makeScale(2.5, 2.5, 2.5))
    expect(out.getAttribute('position').array).toBeInstanceOf(Float32Array)
    expect(positions(out)).toEqual([-2.5, 0, 0, 0, 2.5, 0, 2.5, 0, 0])
    // the uv is denormalized as well, and the normal stays a unit vector
    expect(out.getAttribute('uv').array).toBeInstanceOf(Float32Array)
    expect(out.getAttribute('uv').getX(2)).toBeCloseTo(1, 4)
    expect(out.getAttribute('normal').getZ(0)).toBeCloseTo(1, 4)
  })

  it('bakes integer positions that are not normalized, whose scale is all on the node', () => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Int16Array([0, 0, 0, 250, 0, 0, 0, 750, 0]), 3))
    const out = bakedCargoGeometry(g, new Matrix4().makeScale(0.001, 0.001, 0.001))
    expect(positions(out)).toEqual([0, 0, 0, 0.25, 0, 0, 0, 0.75, 0])
  })

  it('reads an interleaved attribute through its stride', () => {
    // x y z and a padding value per vertex
    const buffer = new InterleavedBuffer(new Float32Array([0, 0, 0, 9, 1, 0, 0, 9, 0, 1, 0, 9]), 4)
    const g = new BufferGeometry()
    g.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
    const out = bakedCargoGeometry(g, new Matrix4().makeTranslation(0, 0, 2))
    expect(positions(out)).toEqual([0, 0, 2, 1, 0, 2, 0, 1, 2])
  })

  it('takes one material group of an indexed geometry, in index order', () => {
    const box = new BoxGeometry(1, 2, 3)
    const group = box.groups[2]! // the +Y face
    const out = bakedCargoGeometry(box, new Matrix4(), group)
    expect(out.index).toBeNull()
    expect(out.getAttribute('position').count).toBe(group.count)
    const flat = box.toNonIndexed().getAttribute('position')
    for (let i = 0; i < group.count; i++) {
      expect(out.getAttribute('position').getX(i)).toBe(flat.getX(group.start + i))
      expect(out.getAttribute('position').getY(i)).toBe(1)
    }
  })

  it('gives every geometry the same attributes, so a quantized piece merges with a float one', () => {
    const plain = new BufferGeometry()
    plain.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)) // no normal, no uv
    const merged = mergeGeometries([bakedCargoGeometry(quantizedTriangle(), new Matrix4()), bakedCargoGeometry(plain, new Matrix4())], false)
    expect(merged).not.toBeNull()
    expect(merged!.getAttribute('position').count).toBe(6)
  })
})
