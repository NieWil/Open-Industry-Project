import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from './partAssets'
import type { PartPackage } from './partPackage'
import { glbTriangles, imageSize, namespaceProblem, publisherOf, submissionProblems } from './partSubmission'

const NS = { namespaces: { acme: { org: 'Acme-Robotics' } } }

describe('namespaces', () => {
  it('lets an account publish under u.<login>, and an organization member under its namespace', () => {
    expect(namespaceProblem('u.jdoe.lift-table', 'JDoe', [], NS)).toBe('')
    expect(namespaceProblem('acme.transfer', 'jdoe', ['acme-robotics'], NS)).toBe('')
    expect(publisherOf('u.jdoe.lift-table', NS)).toBe('jdoe')
    expect(publisherOf('acme.transfer', NS)).toBe('Acme-Robotics')
  })

  it("refuses another account's, an unregistered or a non-member's namespace, and the project's own", () => {
    expect(namespaceProblem('u.someone.x', 'jdoe', [], NS)).toMatch(/another account's/)
    expect(namespaceProblem('u.jdoe', 'jdoe', [], NS)).toMatch(/u.<your GitHub login>/)
    expect(namespaceProblem('globex.x', 'jdoe', [], NS)).toMatch(/not registered/)
    expect(namespaceProblem('acme.x', 'jdoe', ['other'], NS)).toMatch(/not a public member/)
    expect(namespaceProblem('oip.conveyor', 'jdoe', [], NS)).toMatch(/project's own/)
  })
})

/** a GLB holding only its JSON chunk */
function glb(json: unknown): Uint8Array {
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(20 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, body.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(body, 20)
  return out
}

/** a PNG header of the given size */
function png(w: number, h: number): Uint8Array {
  const out = new Uint8Array(24)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const dv = new DataView(out.buffer)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  return out
}

describe('asset limits', () => {
  it('counts triangles from the accessors, indexed or not', () => {
    const json = { meshes: [{ primitives: [{ indices: 0 }, { attributes: { POSITION: 1 } }, { mode: 1, indices: 0 }] }], accessors: [{ count: 300 }, { count: 30 }] }
    expect(glbTriangles(glb(json))).toBe(110)
  })

  it('reads an image size from its header', () => {
    expect(imageSize(png(512, 256))).toEqual({ width: 512, height: 256 })
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    webp.set([0xff, 0x07, 0x00, 0xff, 0x03, 0x00], 24) // 2048 x 1024, stored minus one
    expect(imageSize(webp)).toEqual({ width: 2048, height: 1024 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0x00, 0x02, 0x00, 3, 0, 0])
    expect(imageSize(jpeg)).toEqual({ width: 512, height: 256 })
  })

  it('refuses an asset the part does not carry, a texture too big and too many triangles', () => {
    const pkg = {
      id: 'u.jdoe.thing',
      name: 'Thing',
      behavior: 'definePart({})',
      geometry: { kind: 'rig', links: [], joints: [] },
      assets: [
        { id: 'served', mime: 'model/gltf-binary', url: '/part-assets/x.glb' },
        { id: 'big', mime: 'image/png', data: bytesToBase64(png(8192, 8192)) },
        { id: 'heavy', mime: 'model/gltf-binary', data: bytesToBase64(glb({ meshes: [{ primitives: [{ indices: 0 }] }], accessors: [{ count: 3_000_000 }] })) },
      ],
    } as unknown as PartPackage
    const problems = submissionProblems(pkg, { partFileBytes: 1000 }).map((p) => p.message)
    expect(problems).toEqual([
      expect.stringMatching(/"served" is not inside the part/),
      expect.stringMatching(/"big" is 8192 x 8192/),
      expect.stringMatching(/1,000,000 triangles/),
    ])
    expect(submissionProblems({ ...pkg, assets: [] }, { partFileBytes: 30 * 1024 * 1024 })[0]?.message).toMatch(/at most 20 MB/)
  })
})
