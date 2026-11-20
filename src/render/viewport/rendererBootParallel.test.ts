import { describe, expect, it } from 'vitest'

/**
 * Canary: createWebGPURenderer must load its thirteen WebGPU-only modules (three/webgpu, the four
 * renderer patches, the outline factory, three/tsl and the node-material factories) in one parallel
 * round. Awaited in sequence, each request waits on the previous response, ~5 s of pure round-trip
 * latency for ~15 KB of code on a real link, with the view mount and the loading cover waiting.
 * Only their install order matters.
 *
 * This is a source-shape test rather than a runtime one because the failure is invisible in every
 * environment a unit test could run in: it only shows up with network latency, and the e2e gate
 * that measures it for real (e2e/verify-first-load.mjs) needs a prod build. A source check runs on
 * every `npm test`, which is where a re-serialisation would actually get caught.
 *
 * If you need a new WebGPU-only chunk: add it to the existing Promise.all and destructure it -
 * don't await it separately.
 */
describe('createWebGPURenderer keeps its chunk loads parallel', () => {
  // `?raw` glob, not node:fs - src/ is browser code and its tsconfig carries no node types
  // (same trick as parts/nodeRigOptimizerGuard.test.ts)
  const src =
    Object.values(
      import.meta.glob('./createRenderer.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
    )[0] ?? ''
  // comments stripped first: this file's own comments quote the pattern they warn about
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('issues every dynamic import from one Promise.all, never a serial await import()', () => {
    const serialAwaits = [...code.matchAll(/await\s+import\(/g)]
    expect(
      serialAwaits.length,
      'a serial `await import()` in createRenderer.ts costs a full round trip before the view can ' +
        'mount - add the module to the existing Promise.all instead',
    ).toBe(0)
    expect(code, 'the parallel chunk load is gone - see this test for why it exists').toContain('await Promise.all([')
  })

  it('still loads the modules the WebGPU path needs', () => {
    // A guard on the guard: if someone "fixes" the test above by deleting the imports, the WebGPU
    // path would silently lose its factories, so assert the set is still requested somewhere.
    for (const mod of [
      'three/webgpu',
      './projectionStats',
      '../parts/metalNodeMaterial',
      '../parts/beltNodeMaterial',
      '../parts/scrollNodeMaterial',
    ]) {
      expect(code, `createRenderer.ts no longer imports ${mod}`).toContain(`import('${mod}')`)
    }
  })
})
