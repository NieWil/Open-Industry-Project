// @unlocked-realm: the CAD kernel's emscripten glue runs in its own worker in the app, never under lockdown
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { inspectGlb } from './parts/glbInspect'
import { convertStep, type OcctKernel } from './stepConvert'
import { bytesToBase64 } from './stepImport'

// the kernel's own test files, shipped in its npm package
const require = createRequire(import.meta.url)
const testFile = (rel: string): Uint8Array => new Uint8Array(readFileSync(require.resolve(`occt-import-js/test/testfiles/${rel}`)))

let occt: OcctKernel
beforeAll(async () => {
  occt = (await (require('occt-import-js') as () => Promise<unknown>)()) as OcctKernel
}, 30_000)

describe('convertStep (real CAD kernel)', () => {
  it('reads the unit a file declares: one 1 m cube stored in inches, millimetres and metres comes out 1 m', () => {
    for (const unit of ['in', 'mm', 'm']) {
      const { stats } = convertStep(occt, testFile(`cube-units/cube-${unit}.step`), { detail: 'normal', minPartMm: 0, mergeByColour: true, upAxis: 'z' })
      expect(stats.size.map((s) => +s.toFixed(4)), unit).toEqual([1, 1, 1])
    }
  })

  it('turns a coloured assembly into a GLB the model import can read, one mesh per colour', () => {
    const { glb, stats } = convertStep(occt, testFile('cax-if/as1-oc-214.stp'), { detail: 'normal', minPartMm: 0, mergeByColour: true, upAxis: 'z' })
    expect(stats.solids).toBe(18)
    expect(stats.meshes).toBe(5) // the CAx-IF assembly paints its 18 solids in 5 colours
    // STEP Z (84 mm) is the height once it is glTF Y
    expect(stats.size.map((s) => +s.toFixed(3))).toEqual([0.2, 0.084, 0.15])
    const contents = inspectGlb(bytesToBase64(glb))
    expect(contents.nodes).toEqual(['colour-1', 'colour-2', 'colour-3', 'colour-4', 'colour-5'])
  })

  it('coarse detail costs fewer triangles than normal', () => {
    const bytes = testFile('cax-if/as1-oc-214.stp')
    const normal = convertStep(occt, bytes, { detail: 'normal', minPartMm: 0, mergeByColour: true, upAxis: 'z' }).stats.triangles
    const coarse = convertStep(occt, bytes, { detail: 'coarse', minPartMm: 0, mergeByColour: true, upAxis: 'z' }).stats.triangles
    expect(coarse).toBeLessThan(normal)
  })

  it('says so when the file is not STEP', () => {
    expect(() => convertStep(occt, new TextEncoder().encode('not a step file'), { detail: 'normal', minPartMm: 0, mergeByColour: true, upAxis: 'z' })).toThrow(/could not be read|no solids/)
  })
})
