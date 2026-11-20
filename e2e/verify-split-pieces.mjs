// Gate: the Part Editor's Split into pieces (editor/rigSplit.ts). Each GLB node of an imported model is drawn by one
// mesh link, the nearest that keeps it (core/glbBox.ts drawnElsewhere), so a split leaves the model as it is, a piece
// split from inside another is drawn once, and deleting or merging a piece gives it back to the model.
//
// The failure it guards is visual and easy to miss: a piece drawn twice (once moving, once left behind), or a piece
// that vanishes for good when its node is deleted.
//
// The model is written here: three unit cubes, Body at x 0 and Head at x 2, with Bit inside Head one further along x.
//
// Asserts:
//   A. import - the model imports onto a whole-scene node that draws all three cubes.
//   B. split - splitting Head draws it on its own node, and the model leaves it out without a hideNodes entry.
//   C. nested - splitting Bit from inside Head draws it once, on its own node under Head.
//   D. at rest - a joint on Head with its pivot moved to the centre leaves every cube where it was.
//   E. delete - deleting Head (and Bit under it) gives both back to the model.
//   F. merge back - merging Head back gives it to the model and keeps Bit as a piece, in place.
// Run: node e2e/verify-split-pieces.mjs
/* global process, console, window, Buffer */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startServer } from './_server.mjs'

/** A GLB of three unit cubes sharing one mesh: Body, and Head with Bit as its child. */
function cubesGlb() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1])
  // twelve outward triangles over the eight corners (corner i: x = i & 1, y = i & 2, z = i & 4)
  const idx = new Uint16Array([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5])
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)])
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'Body', mesh: 0 },
      { name: 'Head', mesh: 0, translation: [2, 0, 0], children: [2] },
      { name: 'Bit', mesh: 0, translation: [1, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b)
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20)
  const binChunk = pad(bin, 0)
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunk = (type, data) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(data.length, 0)
    h.writeUInt32LE(type, 4)
    return Buffer.concat([h, data])
  }
  return Buffer.concat([head, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)])
}

let failed = false
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${msg}`)
  if (!ok) failed = true
}

const dir = mkdtempSync(join(tmpdir(), 'oip-split-'))
writeFileSync(join(dir, 'drill.glb'), cubesGlb())

const { url, vite } = await startServer()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => !!window.__oip?.store && !!window.__oip.view, null, { timeout: 60000, polling: 200 })
  await page.evaluate(() => window.localStorage.setItem('oip-web/tutorial-done', '1'))
  const settle = () => page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000, polling: 100 })

  // which links draw each cube, read from the rendered part, and each cube's centre in world space
  const drawn = () =>
    page.evaluate(() => {
      const partId = window.__oip.store.getState().focusedPartId
      const out = {}
      window.__oip.view.scene.traverse((o) => {
        if (!o.isMesh || !['Body', 'Head', 'Bit'].includes(o.name)) return
        let link = null
        let part = null
        for (let p = o; p; p = p.parent) {
          if (!link && p.userData.linkName) link = p.userData.linkName
          if (!part && p.userData.partId) part = p.userData.partId
        }
        if (part !== partId) return
        o.updateWorldMatrix(true, false)
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
        const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
        ;(out[o.name] ??= []).push({ link, centre: [0, 1, 2].map((k) => +((b.min.getComponent(k) + b.max.getComponent(k)) / 2).toFixed(4)) })
      })
      return out
    })
  const linksOf = (d, name) => (d[name] ?? []).map((e) => e.link).sort().join(',')
  const geometry = (pkgId) => page.evaluate((id) => window.__oip.getPackage(id).geometry, pkgId)
  const select = (pkgId, name) =>
    page.evaluate(([, n]) => window.__oip.store.selectRigNode(window.__oip.store.getState().focusedPartId, n), [pkgId, name])
  const chip = (name) => page.locator('[data-testid="split-pieces"] button', { hasText: new RegExp(`^${name}$`) })

  // --- A: import ---
  await page.locator('input[type=file][accept*=".oippart"]').setInputFiles(join(dir, 'drill.glb'))
  await page.locator('.inspector-hint', { hasText: /^Imported drill\.glb/ }).waitFor({ timeout: 60000 })
  await settle()
  const pkgId = await page.evaluate(() => window.__oip.store.getState().userPackages.find((p) => p.name === 'drill')?.id ?? null)
  check(pkgId !== null, `the model imports as a part (${pkgId})`)
  const model = (await geometry(pkgId)).links.find((l) => l.shape.kind === 'mesh')
  check(!!model && !model.shape.keepNode && !model.shape.node, `it lands on a whole-scene node (${model?.name})`)
  await select(pkgId, model.name)
  const a = await drawn()
  check(linksOf(a, 'Body') === model.name && linksOf(a, 'Head') === model.name && linksOf(a, 'Bit') === model.name, `the model node draws all three cubes (${JSON.stringify(a)})`)

  // --- B: split Head ---
  await chip('Head').click()
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode?.linkName === 'Head', null, { timeout: 10000 })
  await settle()
  const b = await drawn()
  check(linksOf(b, 'Head') === 'Head' && linksOf(b, 'Bit') === 'Head' && linksOf(b, 'Body') === model.name, `Head and the Bit inside it are drawn once, by the new node (${JSON.stringify(b)})`)
  const gB = await geometry(pkgId)
  check(!gB.links.find((l) => l.name === model.name).shape.hideNodes, 'the model node gets no hideNodes entry')
  check(b.Head?.[0]?.centre.join() === a.Head?.[0]?.centre.join(), `Head stays where it was (${b.Head?.[0]?.centre} vs ${a.Head?.[0]?.centre})`)

  // --- C: split Bit from inside Head ---
  check((await chip('Head').count()) === 0 && (await chip('Bit').count()) === 1, 'Head is not offered again, and Bit is')
  await chip('Bit').click()
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode?.linkName === 'Bit', null, { timeout: 10000 })
  await settle()
  const c = await drawn()
  check(linksOf(c, 'Bit') === 'Bit' && linksOf(c, 'Head') === 'Head' && linksOf(c, 'Body') === model.name, `each cube is drawn once, Bit by its own node (${JSON.stringify(c)})`)
  check((await geometry(pkgId)).links.find((l) => l.name === 'Bit')?.parent === 'Head', 'Bit sits under Head, so it follows Head')
  check(c.Bit?.[0]?.centre.join() === a.Bit?.[0]?.centre.join(), `Bit stays where it was (${c.Bit?.[0]?.centre} vs ${a.Bit?.[0]?.centre})`)

  // --- D: a joint on Head, its pivot at the centre: nothing moves at rest ---
  await select(pkgId, 'Head')
  await page.getByRole('button', { name: 'Add joint' }).click()
  await page.getByTestId('pivot-centre').click()
  await settle()
  const d = await drawn()
  const same = (x, y) => ['Body', 'Head', 'Bit'].every((n) => x[n]?.[0]?.centre.join() === y[n]?.[0]?.centre.join())
  check(same(d, a), `with a joint and a centred pivot, every cube is where it was (${JSON.stringify(d)})`)
  const gD = await geometry(pkgId)
  check(gD.links.some((l) => l.name === 'Head-pivot') && gD.joints.some((j) => j.link === 'Head-pivot'), 'the pivot went onto a frame above Head, which carries the joint')

  // --- E: delete Head and what is under it: the model draws them again ---
  await page.evaluate((id) => window.__oip.controller.deleteRigNode(id, 'Head'), pkgId)
  await settle()
  const e = await drawn()
  check(linksOf(e, 'Head') === model.name && linksOf(e, 'Bit') === model.name, `deleting Head gives Head and Bit back to the model (${JSON.stringify(e)})`)
  check(same(e, a), 'and they are where they were')

  // --- F: merge back Head, keeping Bit as a piece ---
  await page.evaluate(() => window.__oip.store.undo())
  await settle()
  await select(pkgId, 'Head')
  await page.getByTestId('merge-piece').click()
  await settle()
  const f = await drawn()
  check(linksOf(f, 'Head') === model.name && linksOf(f, 'Bit') === 'Bit', `merging Head back gives it to the model and keeps Bit a piece (${JSON.stringify(f)})`)
  const gF = await geometry(pkgId)
  check(!gF.links.some((l) => l.name === 'Head' || l.name === 'Head-pivot') && gF.joints.length === 0, 'Head goes with its pivot frame and joint')
  check(same(f, a), 'every cube is where it was')

  check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`)
} catch (e) {
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`)
  failed = true
} finally {
  await browser.close()
  vite.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'PASS')
process.exit(failed ? 1 : 0)
