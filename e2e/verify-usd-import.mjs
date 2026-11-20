// A USD model imports through the rig Inspector's "Import model...": the USD reader composes it in its own worker
// and the import writes a GLB that becomes the selected node's mesh (editor/usdImport.ts, core/usdToGlb.ts).
//
//   A) the reader loads lazily: its wasm is not fetched until a USD model is picked
//   B) a lone root layer whose payload is elsewhere is found to be an index before anything converts: the panel
//      asks for its folder and offers no Convert; Cancel imports nothing
//   C) a lone layer that holds its whole model offers Convert straight away
//   D) the folder imports: composition is honoured (payload, reference, variant, an override from the stronger
//      layer, units and up axis), each material is one mesh, the texture is embedded once, and the part, which is
//      just the model, is fitted to it
//   E) Import part takes a model file and makes a new part of it, named after the file and fitted to it
//
// The model is written here, first-party, so nothing third-party is checked in: a 60 x 40 x 30 cm crate in
// centimetres, Z up, whose body is a payload, whose lid is a reference placed by an override, and whose sides and
// caps are two materials of one mesh (GeomSubsets), the sides textured.
//
//   node e2e/verify-usd-import.mjs
/* global process, console, window, localStorage, Buffer, TextDecoder */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { startServer } from './_server.mjs'
import { chromium } from 'playwright'

// ---- the model ------------------------------------------------------------------------------------------------

/** An 8 x 8 RGBA PNG, a two-colour check. */
function checkerPng() {
  const w = 8
  const rows = []
  for (let y = 0; y < w; y++) {
    const row = [0] // filter: none
    for (let x = 0; x < w; x++) row.push(...((x + y) % 2 ? [200, 60, 40, 255] : [240, 200, 60, 255]))
    rows.push(...row)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

const box = (sx, sy, sz) => {
  const p = []
  for (let i = 0; i < 8; i++) p.push(`(${i & 1 ? sx / 2 : -sx / 2}, ${i & 2 ? sy / 2 : -sy / 2}, ${i & 4 ? sz : 0})`)
  return p.join(', ')
}
// six outward quads: bottom, top, -y, +y, -x, +x
const QUADS = '0, 2, 3, 1, 4, 5, 7, 6, 0, 1, 5, 4, 2, 6, 7, 3, 0, 4, 6, 2, 1, 3, 7, 5'
const ST = Array(6).fill('(0, 0), (1, 0), (1, 1), (0, 1)').join(', ')
/** a UsdPreviewSurface material at path `mat`, with these surface inputs and any further shaders */
const surface = (mat, inputs, extra = '') => `
        def Material "${mat.split('/').pop()}"
        {
            token outputs:surface.connect = <${mat}/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
${inputs}
                token outputs:surface
            }${extra}
        }`

const ROOT = `#usda 1.0
(
    defaultPrim = "Crate"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "Crate" (
    prepend payload = @./payloads/body.usda@</Body>
    variants = {
        string size = "large"
    }
    prepend variantSets = "size"
)
{
    over "Lid"
    {
        double3 xformOp:translate = (0, 0, 30)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    variantSet "size" = {
        "large" {
        }
        "small" {
            double3 xformOp:scale = (0.5, 0.5, 0.5)
            uniform token[] xformOpOrder = ["xformOp:scale"]
        }
    }
}
`

const BODY = `#usda 1.0
(
    defaultPrim = "Body"
)

def Xform "Body"
{
    def Mesh "Box" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
        int[] faceVertexIndices = [${QUADS}]
        point3f[] points = [${box(60, 40, 30)}]
        texCoord2f[] primvars:st = [${ST}] (
            interpolation = "faceVarying"
        )
        uniform token subsetFamily:materialBind:familyType = "partition"
        def GeomSubset "Sides" (
            prepend apiSchemas = ["MaterialBindingAPI"]
        )
        {
            uniform token elementType = "face"
            uniform token familyName = "materialBind"
            int[] indices = [2, 3, 4, 5]
            rel material:binding = </Body/Materials/Painted>
        }
        def GeomSubset "Caps" (
            prepend apiSchemas = ["MaterialBindingAPI"]
        )
        {
            uniform token elementType = "face"
            uniform token familyName = "materialBind"
            int[] indices = [0, 1]
            rel material:binding = </Body/Materials/Rubber>
        }
    }

    def Xform "Lid" (
        prepend references = @./lid.usda@</Lid>
    )
    {
        double3 xformOp:translate = (0, 0, 50)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }

    def Scope "Materials"
    {${surface(
      '/Body/Materials/Painted',
      `                color3f inputs:diffuseColor.connect = </Body/Materials/Painted/Albedo.outputs:rgb>
                float inputs:roughness = 0.4
                float inputs:metallic = 0`,
      `
            def Shader "Albedo"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @../textures/paint.png@
                float2 inputs:st.connect = </Body/Materials/Painted/St.outputs:result>
                float3 outputs:rgb
            }
            def Shader "St"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st"
                float2 outputs:result
            }`,
    )}${surface(
      '/Body/Materials/Rubber',
      `                color3f inputs:diffuseColor = (0.05, 0.05, 0.05)
                float inputs:roughness = 0.9`,
    )}
    }
}
`

const LID = `#usda 1.0
(
    defaultPrim = "Lid"
)

def Xform "Lid"
{
    def Mesh "Slab" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
        int[] faceVertexIndices = [${QUADS}]
        point3f[] points = [${box(60, 40, 2)}]
        rel material:binding = </Lid/Red>
    }${surface(
      '/Lid/Red',
      `                color3f inputs:diffuseColor = (0.8, 0.05, 0.05)
                float inputs:roughness = 0.5`,
    )}
}
`

// one self-contained layer, for Import part: a slab 1.2 m long, 0.8 m deep and 0.1 m high, in metres, Z up
const SLAB = `#usda 1.0
(
    defaultPrim = "Slab"
    metersPerUnit = 1
    upAxis = "Z"
)

def Mesh "Slab" (
    prepend apiSchemas = ["MaterialBindingAPI"]
)
{
    int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
    int[] faceVertexIndices = [${QUADS}]
    point3f[] points = [${box(1.2, 0.8, 0.1)}]
    rel material:binding = </Slab/Grey>
${surface('/Slab/Grey', '                color3f inputs:diffuseColor = (0.5, 0.5, 0.5)')}
}
`

const dir = mkdtempSync(join(tmpdir(), 'oip-usd-'))
const model = join(dir, 'crate')
mkdirSync(join(model, 'payloads'), { recursive: true })
mkdirSync(join(model, 'textures'))
writeFileSync(join(model, 'crate.usda'), ROOT)
writeFileSync(join(model, 'payloads', 'body.usda'), BODY)
writeFileSync(join(model, 'payloads', 'lid.usda'), LID)
writeFileSync(join(model, 'textures', 'paint.png'), checkerPng())
writeFileSync(join(dir, 'grey_slab.usda'), SLAB)

// ---- the gate -------------------------------------------------------------------------------------------------

const { url: URL, vite } = await startServer()
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.addInitScript(() => localStorage.setItem('oip-web/tutorial-done', '1'))
const wasmFetches = []
page.on('request', (r) => {
  if (/usd_wasm_bg.*\.wasm/.test(r.url())) wasmFetches.push(r.url())
})
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
try {
  await page.goto(URL, { timeout: 120000 }) // a cold dev server transforms the whole graph on this first load
  await page.waitForSelector('.viewport canvas', { timeout: 25000 })
  await page.waitForFunction(() => !!window.__oip?.controller, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 120000 })

  // "New part": a blank single-box part with its 'body' node selected, so the node panel is up
  const pkgId = await page.evaluate(() => window.__oip.controller.createBlankPart())
  await page.waitForFunction(() => window.__oip.store.getState().selectedRigNode !== null, null, { timeout: 10000 })
  const shape = () =>
    page.evaluate((id) => {
      const pkg = window.__oip.getPackage(id)
      const l = pkg.geometry.links.find((x) => x.name === 'body')
      const asset = l.shape.kind === 'mesh' ? pkg.assets?.find((a) => a.id === l.shape.asset) : undefined
      if (!asset?.data) return { kind: l.shape.kind }
      const bytes = Uint8Array.from(window.atob(asset.data), (c) => c.charCodeAt(0))
      const len = new DataView(bytes.buffer).getUint32(12, true)
      return { kind: l.shape.kind, mime: asset.mime, gltf: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) }
    }, pkgId)
  check('A  the reader wasm is not fetched before a USD import', wasmFetches.length === 0, wasmFetches.join(', '))

  const input = page.getByTestId('model-file-input')
  await input.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
  check('the model picker accepts USD files', (await input.count()) === 1, `${await input.count()} input(s)`)

  // B: the lone root layer is checked before anything converts: its payload is not among the picked files, so it is
  // an index, and the panel asks for its folder instead of offering a conversion into nothing
  await input.setInputFiles(join(model, 'crate.usda'))
  const options = page.getByTestId('usd-import-options')
  await options.waitFor({ timeout: 5000 })
  const needsFolder = page.getByTestId('usd-needs-folder')
  await needsFolder.waitFor({ timeout: 60000 })
  const needText = (await needsFolder.textContent()) ?? ''
  check('A  the reader wasm is fetched once a USD model is picked', wasmFetches.length >= 1)
  check('B  a lone index layer is found out before converting, and the panel asks for its folder', /index of a model/.test(needText) && (await page.getByTestId('usd-pick-folder').count()) === 1, needText)
  check('B  ...and offers no conversion', (await page.getByTestId('usd-convert').count()) === 0)
  await options.getByRole('button', { name: 'Cancel' }).click()
  check('B  Cancel imports nothing', (await shape()).kind === 'box' && !(await options.isVisible()))

  // C: a layer that holds its whole model passes the check and offers Convert at once
  await input.setInputFiles(join(dir, 'grey_slab.usda'))
  await options.waitFor({ timeout: 5000 })
  await page.getByTestId('usd-convert').waitFor({ timeout: 60000 })
  check('C  a self-contained layer offers Convert, with no call for its folder', (await needsFolder.count()) === 0)
  await options.getByRole('button', { name: 'Cancel' }).click()

  // D: the folder
  await page.getByTestId('usd-folder-input').setInputFiles(model)
  await options.waitFor({ timeout: 5000 })
  check('D  picking the folder shows its options, with its one model file', /Folder crate: 4 files/.test((await options.textContent()) ?? '') && (await page.getByTestId('usd-root').count()) === 0)
  await page.getByTestId('usd-convert').click()
  const done = page.locator('.inspector-hint', { hasText: /^Imported crate\.usda|^Could not import|^Nothing to import/ })
  await done.waitFor({ timeout: 60000 })
  const text = (await done.textContent()) ?? ''
  check('D  the Inspector reports the import', /^Imported crate\.usda: 2 parts, 3 meshes/.test(text), text)

  const s = await shape()
  check('D  the node is now a mesh of an embedded GLB', s.kind === 'mesh' && s.mime === 'model/gltf-binary')
  if (s.gltf) {
    const g = s.gltf
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const m of g.meshes)
      for (const p of m.primitives) {
        const a = g.accessors[p.attributes.POSITION]
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], a.min[k])
          hi[k] = Math.max(hi[k], a.max[k])
        }
      }
    const size = hi.map((h, k) => +(h - lo[k]).toFixed(3))
    // centimetres to metres, Z up to Y up, the large variant (scale 1), and the lid at 30 cm from the root layer's
    // override (the payload's own 50 cm is weaker): 0.60 x 0.32 x 0.40 m, standing on Y = 0
    check('D  units, up axis, variant and the stronger override all apply', size.join() === '0.6,0.32,0.4' && Math.abs(lo[1]) < 1e-6, `size ${size.join(' x ')}, base ${lo[1]}`)
    const names = g.materials.map((m) => m.name).sort()
    check('D  one mesh per material: the subsets split, the referenced lid keeps its own', names.join() === 'Painted,Red,Rubber' && g.meshes.length === 3, names.join(', '))
    const painted = g.materials.find((m) => m.name === 'Painted')
    check('D  the textured material embeds its image once', g.images?.length === 1 && painted?.pbrMetallicRoughness?.baseColorTexture?.index === 0, `${g.images?.length} image(s)`)
    const rubber = g.materials.find((m) => m.name === 'Rubber')
    check(
      'D  constant inputs carry over',
      Math.abs(rubber.pbrMetallicRoughness.baseColorFactor[0] - 0.05) < 0.01 && Math.abs(rubber.pbrMetallicRoughness.roughnessFactor - 0.9) < 0.01,
      JSON.stringify(rubber.pbrMetallicRoughness),
    )
  }
  // the part was just the model, so it is fitted to it: standing on the floor, a collider and bounds of its size
  const fit = await page.evaluate((id) => {
    const g = window.__oip.getPackage(id).geometry
    return { links: g.links.map((l) => ({ name: l.name, offset: l.offset, hidden: !!l.hidden, size: l.shape.size })), bounds: g.bounds }
  }, pkgId)
  const body = fit.links.find((l) => l.name === 'body')
  const collider = fit.links.find((l) => l.name === 'collider')
  check(
    'D  the part is fitted to the model: on the floor, a hidden collider and bounds of its size',
    Math.abs(body?.offset[1] ?? 1) < 1e-6 && collider?.hidden && collider.size?.map((v) => +v.toFixed(3)).join() === '0.6,0.32,0.4' && +fit.bounds?.top.toFixed(3) === 0.32,
    JSON.stringify(fit),
  )
  check('D  the Inspector says the part was fitted', /The part now fits the model/.test(text), text)
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })

  // E: Import part takes a model file and makes a new part of it, named after the file, opened at its options
  await page.evaluate(() => window.__oip.controller.closePartScene())
  await page.locator('input[type=file][accept*=".oippart"]').setInputFiles(join(dir, 'grey_slab.usda'))
  await options.waitFor({ timeout: 10000 })
  const made = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    const id = s.packageEdit?.packageId ?? s.focusedPartId
    const pkg = s.userPackages.find((p) => p.name === 'grey slab')
    return { open: !!id, pkgId: pkg?.id ?? null }
  })
  check('E  Import part opens a new part named after the model, at its import options', made.open && made.pkgId !== null && /grey_slab\.usda/.test((await options.textContent()) ?? ''), JSON.stringify(made))
  await page.getByTestId('usd-convert').click()
  const slabDone = page.locator('.inspector-hint', { hasText: /^Imported grey_slab\.usda|^Could not import|^Nothing to import/ })
  await slabDone.waitFor({ timeout: 60000 })
  const slab = made.pkgId ? await page.evaluate((id) => window.__oip.getPackage(id).geometry.bounds, made.pkgId) : null
  check('E  the new part is fitted to its model', !!slab && +slab.length.toFixed(3) === 1.2 && +slab.width.toFixed(3) === 0.8 && +slab.top.toFixed(3) === 0.1, JSON.stringify(slab))
  const slabText = (await slabDone.textContent()) ?? ''
  check('E  the import says how to place it', /drag “grey slab” from the Parts dock/.test(slabText), slabText)
  await page.evaluate(() => window.__oip.controller.closePartScene())
  const card = page.locator(`.catalog-dock button.catalog-card-main[data-package-id="${made.pkgId}"]`)
  check('E  back in the scene, the new part is a card in the Parts dock', (await card.count()) === 1 && /grey slab/.test((await card.getAttribute('title')) ?? ''), (await card.getAttribute('title').catch(() => null)) ?? 'no card')

  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout: 60000 })
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  harness: ${e?.message ?? e}`)
} finally {
  await browser.close()
  vite.kill()
  rmSync(dir, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
